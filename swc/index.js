const { execSync } = require("child_process");
const path = require("path");

/**
 * Detects the current git branch
 * @returns {string|null} The current branch name or null if detection fails
 */
function detectGitBranch() {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
    }).trim();
    return branch || null;
  } catch (error) {
    return null;
  }
}

/**
 * Extracts repository name from GitHub remote URL
 * @returns {string|null} Repository name if detected, null otherwise
 */
function detectGitRepoName() {
  try {
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
      return `${owner}/${repo}`;
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Creates SWC plugin configuration with auto-detected git information
 * @param {Object} userConfig - User-provided configuration options
 * @returns {Array} SWC plugin configuration array
 */
function createSWCPlugin(userConfig = {}) {
  // Auto-detect git information
  const repoName = detectGitRepoName();
  const branchName = detectGitBranch();

  // Merge with user config
  const config = {
    repo_name: repoName,
    branch_name: branchName,
    ...userConfig,
  };

  // Return the plugin configuration array
  return [path.resolve(__dirname, "codepress_engine.wasm"), config];
}

// Support both CommonJS and ES6 imports
module.exports = createSWCPlugin;
