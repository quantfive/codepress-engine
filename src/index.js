// babel-plugin-codepress-html
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const { execSync } = require("child_process");

// Keep track of the last request time to throttle requests
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 0; // Minimum 50ms between requests

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

  // Flag to ensure repo/branch attributes are added only once globally
  let globalAttributesAdded = false;

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

  // Function to send file mappings to the database in bulk with retries
  const saveFileMappingsToDatabase = async (
    mappings,
    retryCount = 3,
    retryDelay = 1000
  ) => {
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

    const endpoint = `${backendUrl}/api/code-sync/bulk-file-mappings`;
    const payload = {
      repository_name: repositoryId,
      branch,
      mappings,
      environment,
    };

    // Track the current retry attempt
    let attempt = 0;
    let lastError = null;

    while (attempt <= retryCount) {
      try {
        // Add attempt number to log if it's a retry
        if (attempt > 0) {
          console.log(
            `\x1b[33mℹ Retry attempt ${attempt}/${retryCount} for saving file mappings...\x1b[0m`
          );
        }

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
          lastError = `HTTP error: ${response.status} - ${errorData}`;

          // Only log error details on final retry attempt
          if (attempt === retryCount) {
            console.error(
              `\x1b[31m✗ Error saving file mappings to database: ${response.status}\x1b[0m`
            );
            console.error(`\x1b[31m  Response: ${errorData}\x1b[0m`);
          }

          // Check for errors that shouldn't trigger retries (e.g. 401, 403)
          if (response.status === 401 || response.status === 403) {
            console.error(
              `\x1b[31m✗ Authentication error - not retrying\x1b[0m`
            );
            return false;
          }
        }
      } catch (error) {
        lastError = error.message;

        // Only log error details on final retry attempt
        if (attempt === retryCount) {
          console.error(
            `\x1b[31m✗ Error saving file mappings to database: ${error.message}\x1b[0m`
          );
        }
      }

      // Increment attempt counter
      attempt++;

      // If this was the last attempt, break and return false
      if (attempt > retryCount) {
        break;
      }

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, retryDelay * attempt));
    }

    // If we reach here, all retries failed
    console.error(
      `\x1b[31m✗ All ${retryCount} attempts to save file mappings failed\x1b[0m`
    );
    return false;
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
      },

      JSXOpeningElement(nodePath, state) {
        const fileHash = state.file.fileHash;
        if (!fileHash) return; // Skip if no hash (e.g., node_modules)

        const { node } = nodePath;
        const t = babel.types; // Ensure babel types are available

        // --- Add file path attribute (codepress-data-fp) ---
        const hasFileAttribute = node.attributes.some(
          (attr) =>
            t.isJSXAttribute(attr) &&
            t.isJSXIdentifier(attr.name, { name: attributeName })
        );
        if (!hasFileAttribute) {
          node.attributes.push(
            t.jsxAttribute(
              t.jsxIdentifier(attributeName),
              t.stringLiteral(fileHash)
            )
          );
        }

        // --- Add repo and branch attributes (once globally to a root-like element) ---
        // Check if repo/branch info is available and attributes haven't been added globally yet
        if (repositoryId && !globalAttributesAdded) {
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
                  t.stringLiteral(repositoryId)
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
              `\x1b[36mℹ Repo/branch attributes added globally. Won't add again.\x1b[0m`
            );
          }
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

      // Throttle requests to avoid overwhelming the server
      const now = Date.now();
      const timeSinceLastRequest = now - lastRequestTime;

      if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        console.log(
          `\x1b[33mℹ Throttling database request (${timeSinceLastRequest}ms since last request)\x1b[0m`
        );
        return;
      }

      // Update last request time
      lastRequestTime = now;

      // Send all mappings in a single batch request with retries
      saveFileMappingsToDatabase(fileMapping)
        .then((success) => {
          // No file fallback
        })
        .catch((error) => {
          console.error(
            `\x1b[31m✗ Database save error: ${error.message}\x1b[0m`
          );
        });
    },
  };
};
