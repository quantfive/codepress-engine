const fs = require("fs");
const path = require("path");
const { parseSync } = require("@swc/core");
const { detectGitBranch, detectGitRepoName } = require("./git-info");

const DEFAULT_OUT_FILE = path.join(".codepress", "component-manifest.json");
const SUPPORTED_EXTENSIONS = new Set([".tsx", ".jsx", ".ts", ".js"]);
const EXCLUDED_FOLDERS = new Set(["node_modules", ".git", ".next", "dist", "build", ".output"]);
const IGNORED_PATH_PATTERNS = [
  /^pages\//,
  /^src\/pages\//,
  /^app\//,
  /^src\/app\//,
];

function walkDirectory(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (!EXCLUDED_FOLDERS.has(entry.name)) {
        results.push(...walkDirectory(fullPath));
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const ext = path.extname(entry.name);
    if (SUPPORTED_EXTENSIONS.has(ext)) {
      results.push(fullPath);
    }
  }

  return results;
}

function looksLikeComponent(name) {
  if (!name) return false;
  const first = name[0];
  return first && first === first.toUpperCase();
}

function fallbackCollectFromSource(source, filePath) {
  const results = [];

  const pushComponent = ({ exportName, displayName, kind, isDefault }) => {
    const cleanDisplayName = displayName || exportName || deriveNameFromPath(filePath);
    if (!cleanDisplayName || !looksLikeComponent(cleanDisplayName)) return;
    results.push({
      exportName,
      displayName: cleanDisplayName,
      kind,
      isDefault,
    });
  };

  const namedFnRegex = /export\s+function\s+([A-Z][A-Za-z0-9_]*)\s*\(/g;
  let match;
  while ((match = namedFnRegex.exec(source))) {
    pushComponent({
      exportName: match[1],
      displayName: match[1],
      kind: "function",
      isDefault: false,
    });
  }

  const namedConstRegex = /export\s+(?:const|let|var)\s+([A-Z][A-Za-z0-9_]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=]+)=>/g;
  while ((match = namedConstRegex.exec(source))) {
    pushComponent({
      exportName: match[1],
      displayName: match[1],
      kind: "arrow",
      isDefault: false,
    });
  }

  const namedClassRegex = /export\s+class\s+([A-Z][A-Za-z0-9_]*)\s+/g;
  while ((match = namedClassRegex.exec(source))) {
    pushComponent({
      exportName: match[1],
      displayName: match[1],
      kind: "class",
      isDefault: false,
    });
  }

  const defaultFnRegex = /export\s+default\s+function\s+([A-Z][A-Za-z0-9_]*)?/g;
  while ((match = defaultFnRegex.exec(source))) {
    const displayName = match[1] || deriveNameFromPath(filePath);
    pushComponent({
      exportName: "default",
      displayName,
      kind: "function",
      isDefault: true,
    });
  }

  const defaultClassRegex = /export\s+default\s+class\s+([A-Z][A-Za-z0-9_]*)?/g;
  while ((match = defaultClassRegex.exec(source))) {
    const displayName = match[1] || deriveNameFromPath(filePath);
    pushComponent({
      exportName: "default",
      displayName,
      kind: "class",
      isDefault: true,
    });
  }

  const defaultIdentRegex = /export\s+default\s+([A-Z][A-Za-z0-9_]*)\b/g;
  while ((match = defaultIdentRegex.exec(source))) {
    pushComponent({
      exportName: "default",
      displayName: match[1],
      kind: "reference",
      isDefault: true,
    });
  }

  return results;
}

function deriveNameFromPath(filePath) {
  const base = path.basename(filePath).replace(/\.[^/.]+$/, "");
  if (looksLikeComponent(base)) {
    return base;
  }
  return null;
}

function expressionKind(node) {
  if (!node) return "expression";
  switch (node.type) {
    case "ArrowFunctionExpression":
      return "arrow";
    case "FunctionExpression":
    case "FunctionDeclaration":
      return "function";
    case "ClassExpression":
    case "ClassDeclaration":
      return "class";
    default:
      return "expression";
  }
}

function extractDisplayNameFromCall(callExpr) {
  if (!callExpr.arguments || callExpr.arguments.length === 0) {
    return null;
  }

  const arg = callExpr.arguments[0];
  if (!arg.expression) return null;

  const expr = arg.expression;
  if (expr.type === "Identifier" && looksLikeComponent(expr.value)) {
    return expr.value;
  }

  if (expr.type === "FunctionExpression" && expr.identifier) {
    return expr.identifier.value;
  }

  return null;
}

function collectFromModule(ast) {
  const components = [];

  for (const item of ast.body) {
    if (item.type === "ExportDeclaration") {
      const decl = item.declaration;
      if (!decl) continue;

      switch (decl.type) {
        case "FunctionDeclaration": {
          const name = decl.identifier?.value;
          if (looksLikeComponent(name)) {
            components.push({
              exportName: name,
              displayName: name,
              kind: "function",
              isDefault: false,
            });
          }
          break;
        }
        case "ClassDeclaration": {
          const name = decl.identifier?.value;
          if (looksLikeComponent(name)) {
            components.push({
              exportName: name,
              displayName: name,
              kind: "class",
              isDefault: false,
            });
          }
          break;
        }
        case "VariableDeclaration": {
          for (const declarator of decl.declarations) {
            if (
              declarator.id.type === "Identifier" &&
              looksLikeComponent(declarator.id.value)
            ) {
              const init = declarator.init;
              if (!init) continue;
              if (
                [
                  "ArrowFunctionExpression",
                  "FunctionExpression",
                  "ClassExpression",
                ].includes(init.type)
              ) {
                components.push({
                  exportName: declarator.id.value,
                  displayName: declarator.id.value,
                  kind: expressionKind(init),
                  isDefault: false,
                });
              } else if (init.type === "CallExpression") {
                const displayName =
                  extractDisplayNameFromCall(init) || declarator.id.value;
                components.push({
                  exportName: declarator.id.value,
                  displayName,
                  kind: "wrapped",
                  isDefault: false,
                });
              }
            }
          }
          break;
        }
        default:
          break;
      }
    } else if (item.type === "ExportDefaultDeclaration") {
      const decl = item.declaration;
      if (!decl) continue;
      switch (decl.type) {
        case "FunctionExpression":
        case "FunctionDeclaration": {
          const displayName = decl.identifier?.value || "DefaultComponent";
          if (!decl.identifier || looksLikeComponent(displayName)) {
            components.push({
              exportName: "default",
              displayName,
              kind: "function",
              isDefault: true,
            });
          }
          break;
        }
        case "ClassExpression":
        case "ClassDeclaration": {
          const displayName = decl.identifier?.value || "DefaultComponent";
          if (!decl.identifier || looksLikeComponent(displayName)) {
            components.push({
              exportName: "default",
              displayName,
              kind: "class",
              isDefault: true,
            });
          }
          break;
        }
        case "Identifier": {
          if (looksLikeComponent(decl.value)) {
            components.push({
              exportName: "default",
              displayName: decl.value,
              kind: "reference",
              isDefault: true,
            });
          }
          break;
        }
        case "CallExpression": {
          const displayName = extractDisplayNameFromCall(decl) || "DefaultComponent";
          components.push({
            exportName: "default",
            displayName,
            kind: "wrapped",
            isDefault: true,
          });
          break;
        }
        default:
          break;
      }
    } else if (item.type === "ExportNamedDeclaration") {
      for (const specifier of item.specifiers || []) {
        if (specifier.type === "ExportSpecifier") {
          const exportName =
            specifier.exported?.value || specifier.orig.value;
          if (looksLikeComponent(exportName)) {
            components.push({
              exportName,
              displayName: exportName,
              kind: "re-export",
              isDefault: false,
            });
          }
        }
      }
    }
  }

  return components;
}

function collectManifest({ outFile, silent = false } = {}) {
  const rootDir = process.cwd();
  const repoFullName = detectGitRepoName();
  const branchName = detectGitBranch() || "main";
  const files = walkDirectory(rootDir);
  const entries = [];

  for (const filePath of files) {
    const relPath = path.relative(rootDir, filePath).replace(/\\/g, "/");
    if (IGNORED_PATH_PATTERNS.some((pattern) => pattern.test(relPath))) {
      continue;
    }

    let source;
    try {
      source = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      continue;
    }

    let ast;
    try {
      ast = parseSync(source, {
        syntax: "typescript",
        tsx: true,
        decorators: true,
        topLevelAwait: true,
        target: "es2020",
      });
    } catch (error) {
      continue;
    }

    let components = collectFromModule(ast);
    if (!components.length) {
      components = fallbackCollectFromSource(source, relPath);
    }
    if (!components.length) continue;

    entries.push({
      filePath: relPath,
      components,
      moduleInfo: null,
    });
  }

  const manifest = {
    repoFullName,
    branchName,
    generatedAt: new Date().toISOString(),
    root: rootDir,
    entries,
  };

  const outputPath = path.resolve(rootDir, outFile || DEFAULT_OUT_FILE);
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));
  if (!silent) {
    console.log(
      `\x1b[32m✓ Component manifest generated with ${entries.length} modules -> ${path.relative(
        rootDir,
        outputPath
      )}\x1b[0m`
    );
  }

  return manifest;
}

module.exports = {
  collectManifest,
};
