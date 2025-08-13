/**
 * @fileoverview Babel plugin for CodePress HTML attribute injection (babel/ directory)
 * This is the production-ready babel plugin copy that uses shared utilities
 */

const path = require("path");
const { encode, decode } = require("../src/utils/encoding");
const { detectGitBranch, detectGitRepoName } = require("../src/utils/git");

/**
 * Babel plugin that adds unique file identifiers to JSX elements
 * This enables visual editing tools to map rendered HTML back to source files
 *
 * This plugin collects all file mappings and sends them in a single batch request
 * to the database with environment support
 */

// Main plugin function
const plugin = function (babel, options = {}) {
  const t = babel.types;

  // Auto-detect git branch and repository if in a git repository
  const currentBranch = detectGitBranch();
  const currentRepoName = detectGitRepoName(); // Renamed from currentRepoId

  // Determine environment
  const _isProduction = process.env.NODE_ENV === "production";

  // Flag to ensure repo/branch attributes are added only once globally
  let globalAttributesAdded = false;

  // Counter for processed files
  let processedFileCount = 0;

  // Configuration options (only attribute names are configurable)
  const {
    attributeName = "codepress-data-fp",
    repoAttributeName = "codepress-github-repo-name",
    branchAttributeName = "codepress-github-branch",
  } = options;

  // Always use auto-detected values
  const repoName = options.repo_name ? options.repo_name : currentRepoName;
  const branch = options.branch_name ? options.branch_name : currentBranch;

  return {
    name: "babel-plugin-codepress-html",
    visitor: {
      Program: {
        enter(nodePath, state) {
          // This runs once per file
          const fullFilePath = state.file.opts.filename || "";
          // Normalize to relative path from cwd
          const relFilePath = path.relative(process.cwd(), fullFilePath);

          // Skip node_modules files
          if (relFilePath.includes("node_modules") || !relFilePath) {
            return;
          }

          // Encode the relative path
          const encodedPath = encode(relFilePath);

          // Store encoded path in file state for other visitors to access
          state.file.encodedPath = encodedPath;

          // Increment processed file counter
          processedFileCount++;
        },
      },

      JSXOpeningElement(nodePath, state) {
        const encodedPath = state.file.encodedPath;
        if (!encodedPath) {
          return;
        } // Skip if no path (e.g., node_modules, empty path)

        const { node } = nodePath;
        const _t = babel.types; // Ensure babel types are available

        // --- Add/Update encoded file path attribute (codepress-data-fp) ---
        const startLine = nodePath.node.loc.start.line;
        // Get the end line from the parent JSXElement (which includes closing tag)
        const endLine = nodePath.parent.loc
          ? nodePath.parent.loc.end.line
          : startLine;
        const currentAttributeValue = `${encodedPath}:${startLine}-${endLine}`;
        let existingAttribute = node.attributes.find(
          (attr) =>
            t.isJSXAttribute(attr) &&
            t.isJSXIdentifier(attr.name, { name: attributeName })
        );

        if (existingAttribute) {
          // Update existing attribute's value
          existingAttribute.value = t.stringLiteral(currentAttributeValue);
        } else {
          // Add new attribute
          node.attributes.push(
            t.jsxAttribute(
              t.jsxIdentifier(attributeName),
              t.stringLiteral(currentAttributeValue)
            )
          );
        }

        // --- Add repo and branch attributes (once globally to a root-like element) ---
        // Check if repo/branch info is available and attributes haven't been added globally yet
        if (repoName && !globalAttributesAdded) {
          // Check if the current element is a suitable root element (html, body, or a top-level div)
          let isSuitableElement = false;
          let elementName = "";
          if (t.isJSXIdentifier(node.name)) {
            elementName = node.name.name;
            // Target html, body, or div as potential root elements
            isSuitableElement = ["html", "body", "div"].includes(elementName);
          }

          // If it's a suitable element, add the attributes and set the global flag
          if (isSuitableElement) {
            // Check if repo attribute already exists (e.g., added manually)
            const hasRepoAttribute = node.attributes.some(
              (attr) =>
                t.isJSXAttribute(attr) &&
                t.isJSXIdentifier(attr.name, { name: repoAttributeName })
            );
            if (!hasRepoAttribute) {
              console.log(
                `\x1b[32m✓ Adding repo attribute globally to <${elementName}> in ${path.basename(state.file.opts.filename)}\x1b[0m`
              );
              node.attributes.push(
                t.jsxAttribute(
                  t.jsxIdentifier(repoAttributeName),
                  t.stringLiteral(repoName)
                )
              );
            }

            // Check if branch attribute already exists
            const hasBranchAttribute = node.attributes.some(
              (attr) =>
                t.isJSXAttribute(attr) &&
                t.isJSXIdentifier(attr.name, { name: branchAttributeName })
            );
            if (!hasBranchAttribute && branch) {
              console.log(
                `\x1b[32m✓ Adding branch attribute globally to <${elementName}> in ${path.basename(state.file.opts.filename)}\x1b[0m`
              );
              node.attributes.push(
                t.jsxAttribute(
                  t.jsxIdentifier(branchAttributeName),
                  t.stringLiteral(branch)
                )
              );
            }

            // Mark that we've added attributes globally
            globalAttributesAdded = true;
            console.log(
              "\x1b[36mℹ Repo/branch attributes added globally. Won't add again.\x1b[0m"
            );
          }
        }
      },
    },

    // Runs after all files are processed
    post() {
      // Display the total number of files processed
      if (processedFileCount > 0) {
        console.log(
          `\x1b[36mℹ Processed ${processedFileCount} files with CodePress\x1b[0m`
        );
      } else {
        console.log("\x1b[33m⚠ No files were processed by CodePress\x1b[0m");
      }
    },
  };
};

module.exports = plugin;
module.exports.decode = decode;
