import type * as Babel from "@babel/core";
import { execSync } from "child_process";
import path from "path";

import type { CodePressPluginOptions } from "./types";
import { ModuleGraphCollector } from "./babel/module-graph";
import { ProvenanceTracker } from "./babel/provenance";

const SECRET = Buffer.from("codepress-file-obfuscation");

const BASE64_URL_SAFE_REPLACEMENTS: Record<string, string> = {
  "+": "-",
  "/": "_",
  "=": "",
};

const BASE64_URL_SAFE_RESTORE: Record<string, string> = {
  "-": "+",
  _: "/",
};

interface CodePressPluginState extends Babel.PluginPass {
  file: Babel.BabelFile & {
    encodedPath?: string;
    moduleGraph?: ModuleGraphCollector;
    provenanceTracker?: ProvenanceTracker;
  };
}

function encode(relPath: string): string {
  if (!relPath) return "";
  const buffer = Buffer.from(relPath);
  for (let index = 0; index < buffer.length; index += 1) {
    buffer[index] = buffer[index] ^ SECRET[index % SECRET.length];
  }

  return buffer
    .toString("base64")
    .replace(/[+/=]/g, (char) => BASE64_URL_SAFE_REPLACEMENTS[char]);
}

export function decode(attributeValue: string | null | undefined): string {
  if (!attributeValue) return "";

  const base64 = attributeValue.replace(
    /[-_]/g,
    (char) => BASE64_URL_SAFE_RESTORE[char]
  );

  const decoded = Buffer.from(base64, "base64");
  for (let index = 0; index < decoded.length; index += 1) {
    decoded[index] = decoded[index] ^ SECRET[index % SECRET.length];
  }

  return decoded.toString();
}

function detectGitBranch(): string {
  const branchFromEnv =
    process.env.GIT_BRANCH ||
    process.env.VERCEL_GIT_COMMIT_REF ||
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    process.env.CI_COMMIT_REF_NAME ||
    process.env.CIRCLE_BRANCH ||
    process.env.BITBUCKET_BRANCH ||
    process.env.BRANCH;

  if (branchFromEnv) {
    return branchFromEnv;
  }

  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
    }).trim();

    return branch || "main";
  } catch (error) {
    console.log(
      "\x1b[33m⚠ Could not detect git branch, using default: main\x1b[0m",
      error
    );
    return "main";
  }
}

function detectGitRepoName(): string | null {
  // Check CI environment variables first
  const vercelOwner = process.env.VERCEL_GIT_REPO_OWNER;
  const vercelSlug = process.env.VERCEL_GIT_REPO_SLUG;

  if (vercelOwner && vercelSlug) {
    const repoId = `${vercelOwner}/${vercelSlug}`;
    console.log(`\x1b[32m✓ Detected GitHub repository from Vercel: ${repoId}\x1b[0m`);
    return repoId;
  }

  // Check GitHub Actions environment variables
  const githubRepo = process.env.GITHUB_REPOSITORY;
  if (githubRepo) {
    console.log(`\x1b[32m✓ Detected GitHub repository from GitHub Actions: ${githubRepo}\x1b[0m`);
    return githubRepo;
  }

  // Fall back to git commands
  try {
    const remoteUrl = execSync("git config --get remote.origin.url", {
      encoding: "utf8",
    }).trim();

    if (!remoteUrl) {
      return null;
    }

    const httpsMatch = remoteUrl.match(
      /https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/
    );

    if (httpsMatch) {
      const [, owner, repo] = httpsMatch;
      const repoId = `${owner}/${repo}`;
      console.log(`\x1b[32m✓ Detected GitHub repository: ${repoId}\x1b[0m`);
      return repoId;
    }

    const sshMatch = remoteUrl.match(
      /git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/
    );

    if (sshMatch) {
      const [, owner, repo] = sshMatch;
      const repoId = `${owner}/${repo}`;
      console.log(`\x1b[32m✓ Detected GitHub repository: ${repoId}\x1b[0m`);
      return repoId;
    }

    console.log(
      "\x1b[33m⚠ Could not parse GitHub repository from remote URL\x1b[0m"
    );
    return null;
  } catch (error) {
    console.log("\x1b[33m⚠ Could not detect git repository\x1b[0m", error);
    return null;
  }
}

export default function codePressPlugin(
  babel: typeof Babel,
  options: CodePressPluginOptions = {}
): Babel.PluginObj<CodePressPluginState> {
  const t = babel.types;

  const currentBranch = detectGitBranch();
  const currentRepoName = detectGitRepoName();

  let globalAttributesAdded = false;
  let processedFileCount = 0;

  const FILE_PATH_ATTRIBUTE_NAME = "codepress-data-fp";
  const REPO_ATTRIBUTE_NAME = "codepress-github-repo-name";
  const BRANCH_ATTRIBUTE_NAME = "codepress-github-branch";

  const repoName = options.repo_name || currentRepoName;
  const branch = options.branch_name || currentBranch;

  // Skip component configuration (like SWC plugin)
  const skipComponents = new Set(
    options.skip_components || ["Slot", "Link"]
  );
  const skipMemberRoots = new Set(
    options.skip_member_roots || ["Primitive"]
  );

  function isSkipComponent(name: Babel.types.JSXIdentifier | Babel.types.JSXMemberExpression | Babel.types.JSXNamespacedName): boolean {
    if (t.isJSXIdentifier(name)) {
      return skipComponents.has(name.name);
    }
    if (t.isJSXMemberExpression(name)) {
      // Check root of member expression
      let root = name.object;
      while (t.isJSXMemberExpression(root)) {
        root = root.object;
      }
      if (t.isJSXIdentifier(root)) {
        return skipMemberRoots.has(root.name);
      }
    }
    return false;
  }

  function isCustomComponent(name: Babel.types.JSXIdentifier | Babel.types.JSXMemberExpression | Babel.types.JSXNamespacedName): boolean {
    if (t.isJSXIdentifier(name)) {
      const firstChar = name.name[0];
      return firstChar === firstChar.toUpperCase();
    }
    return t.isJSXMemberExpression(name) || t.isJSXNamespacedName(name);
  }

  return {
    name: "babel-plugin-codepress-html",
    visitor: {
      Program: {
        enter(nodePath, state) {
          const filename = state.file.opts.filename ?? "";
          const relativePath = path.relative(process.cwd(), filename);

          if (relativePath.includes("node_modules") || !relativePath) {
            return;
          }

          state.file.encodedPath = encode(relativePath);
          state.file.moduleGraph = new ModuleGraphCollector(relativePath);
          state.file.provenanceTracker = new ProvenanceTracker(relativePath);
          processedFileCount += 1;

          // Collect bindings first (needed for provenance tracking)
          state.file.provenanceTracker.collectBindings(nodePath);

          // Traverse to collect module graph
          nodePath.traverse({
            ImportDeclaration(path) {
              state.file.moduleGraph!.visitImportDeclaration(path);
            },
            ExportNamedDeclaration(path) {
              state.file.moduleGraph!.visitExportNamedDeclaration(path);
            },
            VariableDeclarator(path) {
              const parent = path.parentPath.node;
              if (t.isVariableDeclaration(parent)) {
                const kind = parent.kind === 'const' ? 'const' : parent.kind === 'let' ? 'let' : 'var';
                state.file.moduleGraph!.visitVariableDeclarator(path, kind);
              }
            },
            FunctionDeclaration(path) {
              if (path.node.id) {
                state.file.moduleGraph!.graph.defs.push({
                  local: path.node.id.name,
                  kind: 'func',
                  span: `${relativePath}:${path.node.id.loc?.start.line || 0}`,
                });
              }
            },
            ClassDeclaration(path) {
              if (path.node.id) {
                state.file.moduleGraph!.graph.defs.push({
                  local: path.node.id.name,
                  kind: 'class',
                  span: `${relativePath}:${path.node.id.loc?.start.line || 0}`,
                });
              }
            },
            AssignmentExpression(path) {
              state.file.moduleGraph!.visitAssignmentExpression(path);
            },
            UpdateExpression(path) {
              state.file.moduleGraph!.visitUpdateExpression(path);
            },
            CallExpression(path) {
              state.file.moduleGraph!.visitCallExpression(path);
            },
          });
        },
        exit(programPath, state) {
          // Inject module graph as globalThis.__CPX_GRAPH[file]
          if (state.file.moduleGraph) {
            const graph = state.file.moduleGraph.getGraph();
            const fileKey = state.file.encodedPath!;
            const graphJson = JSON.stringify(graph);

            const graphInjectionCode = `
try {
  var g = (typeof globalThis !== 'undefined' ? globalThis : window);
  g.__CPX_GRAPH = g.__CPX_GRAPH || {};
  g.__CPX_GRAPH[${JSON.stringify(fileKey)}] = JSON.parse(${JSON.stringify(graphJson)});
} catch(_e) {}
`;

            const graphAst = babel.template.ast(graphInjectionCode);
            if (Array.isArray(graphAst)) {
              programPath.node.body.unshift(...graphAst);
            } else {
              programPath.node.body.unshift(graphAst);
            }
          }

          // Inject repo/branch config into window.__CODEPRESS_CONFIG__ (cleaner than DOM attributes)
          if (!globalAttributesAdded && repoName && state.file.encodedPath) {
            const escapedRepo = repoName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const escapedBranch = (branch || 'main').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const scriptCode = `
try {
  if (typeof window !== 'undefined') {
    window.__CODEPRESS_CONFIG__ = Object.assign(window.__CODEPRESS_CONFIG__ || {}, {
      repo: "${escapedRepo}",
      branch: "${escapedBranch}"
    });
  }
} catch (_) {}
`;

            const scriptAst = babel.template.ast(scriptCode);
            if (Array.isArray(scriptAst)) {
              programPath.node.body.unshift(...scriptAst);
            } else {
              programPath.node.body.unshift(scriptAst);
            }

            globalAttributesAdded = true;
            console.log(
              `\x1b[32m✓ Injected config + graph in ${path.basename(
                state.file.opts.filename ?? "unknown"
              )}\x1b[0m`
            );
          }
        },
      },
      JSXOpeningElement(nodePath, state) {
        const encodedPath = state.file.encodedPath;
        if (!encodedPath || !state.file.provenanceTracker) {
          return;
        }

        const { node } = nodePath;
        const startLine = node.loc?.start.line ?? 0;
        const parentLoc = nodePath.parent.loc;
        const endLine = parentLoc?.end.line ?? startLine;
        const attributeValue = `${encodedPath}:${startLine}-${endLine}`;

        // Add basic file path attribute
        const existingAttribute = node.attributes.find(
          (attr): attr is Babel.types.JSXAttribute =>
            t.isJSXAttribute(attr) &&
            t.isJSXIdentifier(attr.name, { name: FILE_PATH_ATTRIBUTE_NAME })
        );

        if (existingAttribute) {
          existingAttribute.value = t.stringLiteral(attributeValue);
        } else {
          node.attributes.push(
            t.jsxAttribute(
              t.jsxIdentifier(FILE_PATH_ATTRIBUTE_NAME),
              t.stringLiteral(attributeValue)
            )
          );
        }

        // Collect provenance from props and children
        const allNodes: any[] = [];
        const symbolRefs: any[] = [];

        // Trace props
        for (const attr of node.attributes) {
          if (t.isJSXAttribute(attr) && attr.value) {
            if (t.isJSXExpressionContainer(attr.value) && t.isExpression(attr.value.expression)) {
              const chain: any[] = [];
              state.file.provenanceTracker!.traceExpression(attr.value.expression, chain);
              allNodes.push(...chain);
              state.file.provenanceTracker!.collectSymbolRefs(attr.value.expression, symbolRefs);
            }
          } else if (t.isJSXSpreadAttribute(attr)) {
            const chain: any[] = [];
            state.file.provenanceTracker!.traceExpression(attr.argument, chain);
            allNodes.push(...chain);
            state.file.provenanceTracker!.collectSymbolRefs(attr.argument, symbolRefs);
          }
        }

        // Trace children
        const parent = nodePath.parent;
        if (t.isJSXElement(parent)) {
          for (const child of parent.children) {
            if (t.isJSXExpressionContainer(child) && t.isExpression(child.expression)) {
              const chain: any[] = [];
              state.file.provenanceTracker!.traceExpression(child.expression, chain);
              allNodes.push(...chain);
              state.file.provenanceTracker!.collectSymbolRefs(child.expression, symbolRefs);
            }
          }
        }

        // Rank candidates and aggregate kinds
        const candidates = state.file.provenanceTracker!.rankCandidates(allNodes);
        const kinds = state.file.provenanceTracker!.aggregateKinds(allNodes);

        // Add callsite candidate
        const filename = state.file.opts.filename ?? "";
        const relativePath = path.relative(process.cwd(), filename);
        const selfTarget = `${relativePath}:${startLine}-${endLine}`;
        const alreadyHasCallsite = candidates.some(
          c => c.reason === 'callsite' && c.target === selfTarget
        );
        if (!alreadyHasCallsite) {
          candidates.push({ target: selfTarget, reason: 'callsite' });
        }

        // Encode metadata
        const candidatesJson = JSON.stringify(candidates);
        const kindsJson = JSON.stringify(kinds);
        const symbolRefsJson = JSON.stringify(symbolRefs);
        const candidatesEnc = encode(candidatesJson);
        const kindsEnc = encode(kindsJson);
        const symbolRefsEnc = encode(symbolRefsJson);

        // Add rich metadata attributes
        node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier("data-codepress-edit-candidates"),
            t.stringLiteral(candidatesEnc)
          )
        );
        node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier("data-codepress-source-kinds"),
            t.stringLiteral(kindsEnc)
          )
        );
        node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier("data-codepress-symbol-refs"),
            t.stringLiteral(symbolRefsEnc)
          )
        );

        // Add callsite attribute
        node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier("data-codepress-callsite"),
            t.stringLiteral(attributeValue)
          )
        );

        // For custom components (not in skip list), wrap with marker
        if (isCustomComponent(node.name) && !isSkipComponent(node.name)) {
          // Note: Wrapping logic similar to SWC could be added here
          // For now, we just add the metadata attributes
        }
      },
    },
    post() {
      if (processedFileCount > 0) {
        console.log(
          `\x1b[36mℹ Processed ${processedFileCount} files with CodePress (full features)\x1b[0m`
        );
      } else {
        console.log("\x1b[33m⚠ No files were processed by CodePress\x1b[0m");
      }
    },
  };
}
