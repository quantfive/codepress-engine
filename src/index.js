// babel-plugin-codepress-html
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const { execSync } = require("child_process");

/**
 * Detects the current git branch
 * @returns {string} The current branch name or 'main' if detection fails
 */
function detectGitBranch() {
  try {
    // Run git command to get current branch
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
    }).trim();
    return branch || "main";
  } catch (error) {
    console.log(
      "\x1b[33m⚠ Could not detect git branch, using default: main\x1b[0m"
    );
    return "main";
  }
}

/**
 * Extracts repository ID from GitHub remote URL
 * Supports formats like:
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 * @returns {string|null} Repository ID if detected, null otherwise
 */
function detectGitRepoId() {
  try {
    // Get the remote URL for the 'origin' remote
    const remoteUrl = execSync("git config --get remote.origin.url", {
      encoding: "utf8",
    }).trim();

    if (!remoteUrl) {
      return null;
    }

    let owner, repo;

    // Parse HTTPS URL format: https://github.com/owner/repo.git
    const httpsMatch = remoteUrl.match(
      /https:\/\/github\.com\/([^\/]+)\/([^\/\.]+)(?:\.git)?$/
    );
    if (httpsMatch) {
      [, owner, repo] = httpsMatch;
    }

    // Parse SSH URL format: git@github.com:owner/repo.git
    const sshMatch = remoteUrl.match(
      /git@github\.com:([^\/]+)\/([^\/\.]+)(?:\.git)?$/
    );
    if (sshMatch) {
      [, owner, repo] = sshMatch;
    }

    if (owner && repo) {
      // For CodePress, we'll assume the repo ID is in format "owner/repo"
      const repoId = `${owner}/${repo}`;
      console.log(`\x1b[32m✓ Detected GitHub repository: ${repoId}\x1b[0m`);
      return repoId;
    }

    console.log(
      "\x1b[33m⚠ Could not parse GitHub repository from remote URL\x1b[0m"
    );
    return null;
  } catch (error) {
    console.log("\x1b[33m⚠ Could not detect git repository\x1b[0m");
    return null;
  }
}

/**
 * Hashes and encodes a string value for use as an attribute
 * Uses a simple two-way encryption scheme so it can be decoded by the extension
 * @param {string} value - The value to hash
 * @returns {string} The hashed value
 */
function hashValue(value) {
  if (!value) return "";

  // Use a fixed key that will be shared with the browser extension
  // This is not high security, just to prevent casual inspection
  const key = "codepress-identifier-key";

  // Create a simple reversible encoding
  const hashedValue = Buffer.from(
    `${key}:${value}:${key.split("").reverse().join("")}`
  ).toString("base64");

  return hashedValue;
}

/**
 * Babel plugin that adds unique file identifiers to JSX elements
 * This enables visual editing tools to map rendered HTML back to source files
 *
 * This plugin collects all file mappings and sends them in a single batch request
 * to the database with environment support
 */
// Export the hash function for use in the browser extension
module.exports.hashValue = hashValue;

// Main plugin function
module.exports = function (babel, options = {}) {
  const t = babel.types;

  // Auto-detect git branch and repository if in a git repository
  const currentBranch = detectGitBranch();
  const currentRepoId = detectGitRepoId();

  // Determine environment
  const isProduction = process.env.NODE_ENV === "production";

  // Default options
  const {
    outputPath = "codepress-file-hash-map.json", // Only used for local fallback
    attributeName = "codepress-data-fp",
    repoAttributeName = "codepress-github-repo-name",
    branchAttributeName = "codepress-github-branch",
    backendUrl = isProduction
      ? "https://api.codepress.dev"
      : "http://localhost:8000",
    repositoryId = currentRepoId,
    apiToken = null,
    branch = currentBranch,
    environment = isProduction ? "production" : "development",
  } = options;

  // We'll keep a mapping to store ID -> real path
  let fileMapping = {};

  // Function to send file mappings to the database in bulk
  const saveFileMappingsToDatabase = async (mappings) => {
    // Check if required config is missing
    if (!repositoryId || !apiToken) {
      console.log(
        "\x1b[33m⚠ Codepress database sync disabled: missing repositoryId or apiToken\x1b[0m"
      );
      return false;
    }

    // Check if mappings is empty
    if (Object.keys(mappings).length === 0) {
      console.log("\x1b[33m⚠ No file mappings to save\x1b[0m");
      return false;
    }

    // Log the number of mappings being sent
    console.log(
      `\x1b[36mℹ Sending ${
        Object.keys(mappings).length
      } file mappings in bulk request\x1b[0m`
    );

    const endpoint = `${backendUrl}/api/bulk-file-mappings`;
    const payload = {
      repository_name: repositoryId,
      branch,
      mappings,
      environment,
    };

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const data = await response.json();
        console.log(
          `\x1b[32m✓ Codepress file mappings saved to ${environment} database successfully\x1b[0m`
        );
        console.log(
          `\x1b[32m  Created: ${data.created_count}, Updated: ${data.updated_count}, Total: ${data.total_mappings}\x1b[0m`
        );
        return true;
      } else {
        const errorData = await response.text();
        console.error(
          `\x1b[31m✗ Error saving file mappings to database: ${response.status}\x1b[0m`
        );
        console.error(`\x1b[31m  Response: ${errorData}\x1b[0m`);
        return false;
      }
    } catch (error) {
      console.error(
        `\x1b[31m✗ Error saving file mappings to database: ${error.message}\x1b[0m`
      );
      return false;
    }
  };

  return {
    name: "babel-plugin-codepress-html",
    visitor: {
      Program(nodePath, state) {
        // This runs once per file
        const fullFilePath = state.file.opts.filename || "";
        // Normalize to relative path from cwd
        const relFilePath = path.relative(process.cwd(), fullFilePath);

        // Skip node_modules files
        if (relFilePath.includes("node_modules")) return;

        // Create a short hash of the relative path
        const hash = crypto
          .createHash("sha1")
          .update(relFilePath)
          .digest("hex")
          .substring(0, 8);

        // Store mapping with repository and branch info
        fileMapping[hash] = {
          filePath: relFilePath,
          repository: repositoryId || "",
          branch: branch || "main",
        };

        // Save hash in file state for other visitors to access
        state.file.fileHash = hash;

        // Add repository and branch attributes to the first JSX element in the main component
        if (repositoryId) {
          // Find the first JSX element in the main component's return statement
          nodePath.traverse({
            ReturnStatement(path) {
              // Skip if we've already added attributes
              if (state.repoAttributesAdded) return;

              // Look for JSX elements in the return statement
              path.traverse({
                JSXOpeningElement(jsxPath) {
                  const { node } = jsxPath;
                  
                  // Only add repo attributes to container elements (html, body, div)
                  const elementName = node.name.name;
                  if (!["html", "body", "div"].includes(elementName)) {
                    return;
                  }

                  // Skip if we've already added attributes
                  if (state.repoAttributesAdded) return;

                  // Check for repo attribute
                  const hasRepoAttribute = node.attributes.some((attr) => {
                    return (
                      t.isJSXAttribute(attr) &&
                      t.isJSXIdentifier(attr.name, { name: repoAttributeName })
                    );
                  });

                  // Check for branch attribute
                  const hasBranchAttribute = node.attributes.some((attr) => {
                    return (
                      t.isJSXAttribute(attr) &&
                      t.isJSXIdentifier(attr.name, {
                        name: branchAttributeName,
                      })
                    );
                  });

                  // Add repo name attribute if needed and available
                  if (!hasRepoAttribute) {
                    // Don't hash the repository name anymore - use plain text
                    console.log(
                      `\x1b[32m✓ Adding repo attribute to ${elementName} element\x1b[0m`
                    );

                    node.attributes.push(
                      t.jsxAttribute(
                        t.jsxIdentifier(repoAttributeName),
                        t.stringLiteral(repositoryId)
                      )
                    );
                  }

                  // Add branch attribute if needed and available
                  if (!hasBranchAttribute && branch) {
                    // Don't hash the branch name anymore - use plain text
                    console.log(
                      `\x1b[32m✓ Adding branch attribute to ${elementName} element\x1b[0m`
                    );

                    node.attributes.push(
                      t.jsxAttribute(
                        t.jsxIdentifier(branchAttributeName),
                        t.stringLiteral(branch)
                      )
                    );
                  }

                  // Mark that we've added attributes
                  state.repoAttributesAdded = true;
                },
              });
            },
          });
        }
      },

      JSXOpeningElement(nodePath, state) {
        const fileHash = state.file.fileHash;
        if (!fileHash) return;

        // Insert attributes if not present
        const { node } = nodePath;

        // Add file path attribute to all JSX elements
        const hasFileAttribute = node.attributes.some((attr) => {
          return (
            t.isJSXAttribute(attr) &&
            t.isJSXIdentifier(attr.name, { name: attributeName })
          );
        });

        if (!hasFileAttribute) {
          node.attributes.push(
            t.jsxAttribute(
              t.jsxIdentifier(attributeName),
              t.stringLiteral(fileHash)
            )
          );
        }
      },
    },

    // Runs after all files are processed
    post() {
      // Display the total number of files processed
      const fileCount = Object.keys(fileMapping).length;
      if (fileCount > 0) {
        console.log(
          `\x1b[36mℹ Processed ${fileCount} files with CodePress\x1b[0m`
        );
      } else {
        console.log("\x1b[33m⚠ No files were processed by CodePress\x1b[0m");
        return;
      }

      // Send all mappings in a single batch request
      saveFileMappingsToDatabase(fileMapping)
        .then((success) => {
          // In development, write to file as fallback if database save failed
          if (!isProduction && !success) {
            try {
              fs.writeFileSync(
                outputPath,
                JSON.stringify(fileMapping, null, 2)
              );
              console.log(
                `\x1b[32m✓ Codepress file mapping written to ${outputPath} as fallback\x1b[0m`
              );
            } catch (error) {
              console.error(
                `\x1b[31m✗ Error writing Codepress file mapping: ${error.message}\x1b[0m`
              );
            }
          }
        })
        .catch((error) => {
          console.error(
            `\x1b[31m✗ Database save error: ${error.message}\x1b[0m`
          );

          // Write to file as fallback in development
          if (!isProduction) {
            try {
              fs.writeFileSync(
                outputPath,
                JSON.stringify(fileMapping, null, 2)
              );
              console.log(
                `\x1b[32m✓ Codepress file mapping written to ${outputPath} as fallback\x1b[0m`
              );
            } catch (fileError) {
              console.error(
                `\x1b[31m✗ Error writing Codepress file mapping: ${fileError.message}\x1b[0m`
              );
            }
          }
        });
    },
  };
};