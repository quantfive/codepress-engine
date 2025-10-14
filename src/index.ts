import type * as Babel from "@babel/core";
import { execSync } from "child_process";
import path from "path";

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

export interface CodePressPluginOptions {
  attributeName?: string;
  repoAttributeName?: string;
  branchAttributeName?: string;
  repo_name?: string;
  branch_name?: string;
}

interface CodePressPluginState extends Babel.PluginPass {
  file: Babel.BabelFile & { encodedPath?: string };
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

  const {
    attributeName = "codepress-data-fp",
    repoAttributeName = "codepress-github-repo-name",
    branchAttributeName = "codepress-github-branch",
  } = options;

  const repoName = options.repo_name ?? currentRepoName;
  const branch = options.branch_name ?? currentBranch;

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
          processedFileCount += 1;
        },
      },
      JSXOpeningElement(nodePath, state) {
        const encodedPath = state.file.encodedPath;
        if (!encodedPath) {
          return;
        }

        const { node } = nodePath;

        const startLine = node.loc?.start.line ?? 0;
        const parentLoc = nodePath.parent.loc;
        const endLine = parentLoc?.end.line ?? startLine;
        const attributeValue = `${encodedPath}:${startLine}-${endLine}`;

        const existingAttribute = node.attributes.find(
          (attr): attr is Babel.types.JSXAttribute =>
            t.isJSXAttribute(attr) &&
            t.isJSXIdentifier(attr.name, { name: attributeName })
        );

        if (existingAttribute) {
          existingAttribute.value = t.stringLiteral(attributeValue);
        } else {
          node.attributes.push(
            t.jsxAttribute(
              t.jsxIdentifier(attributeName),
              t.stringLiteral(attributeValue)
            )
          );
        }

        if (!repoName || globalAttributesAdded) {
          return;
        }

        if (!t.isJSXIdentifier(node.name)) {
          return;
        }

        const elementName = node.name.name;
        const isRootElement = ["html", "body", "div"].includes(elementName);

        if (!isRootElement) {
          return;
        }

        const hasRepoAttribute = node.attributes.some(
          (attr) =>
            t.isJSXAttribute(attr) &&
            t.isJSXIdentifier(attr.name, { name: repoAttributeName })
        );

        if (!hasRepoAttribute) {
          console.log(
            `\x1b[32m✓ Adding repo attribute globally to <${elementName}> in ${path.basename(
              state.file.opts.filename ?? "unknown"
            )}\x1b[0m`
          );
          node.attributes.push(
            t.jsxAttribute(
              t.jsxIdentifier(repoAttributeName),
              t.stringLiteral(repoName)
            )
          );
        }

        const hasBranchAttribute = node.attributes.some(
          (attr) =>
            t.isJSXAttribute(attr) &&
            t.isJSXIdentifier(attr.name, { name: branchAttributeName })
        );

        if (!hasBranchAttribute && branch) {
          console.log(
            `\x1b[32m✓ Adding branch attribute globally to <${elementName}> in ${path.basename(
              state.file.opts.filename ?? "unknown"
            )}\x1b[0m`
          );
          node.attributes.push(
            t.jsxAttribute(
              t.jsxIdentifier(branchAttributeName),
              t.stringLiteral(branch)
            )
          );
        }

        globalAttributesAdded = true;
        console.log(
          "\x1b[36mℹ Repo/branch attributes added globally. Won't add again.\x1b[0m"
        );
      },
    },
    post() {
      if (processedFileCount > 0) {
        console.log(
          `\x1b[36mℹ Processed ${processedFileCount} files with CodePress\x1b[0m`
        );
      } else {
        console.log("\x1b[33m⚠ No files were processed by CodePress\x1b[0m");
      }
    },
  };
}
