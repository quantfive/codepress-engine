/**
 * @fileoverview Git utilities for CodePress
 * Provides functionality to detect git branch and repository information
 */

const { execSync } = require("child_process");

/**
 * Detects the current git branch from environment variables or git command
 * Supports various CI/CD environments including Vercel, GitHub Actions, GitLab CI, etc.
 * @returns {string} The current branch name or 'main' if detection fails
 */
function detectGitBranch() {
  // Check environment variables first (CI/CD environments)
  const fromEnv =
    process.env.GIT_BRANCH ||
    // Vercel
    process.env.VERCEL_GIT_COMMIT_REF ||
    // GitHub Actions (PRs use GITHUB_HEAD_REF, pushes use GITHUB_REF_NAME)
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    // GitLab CI
    process.env.CI_COMMIT_REF_NAME ||
    // CircleCI
    process.env.CIRCLE_BRANCH ||
    // Bitbucket Pipelines
    process.env.BITBUCKET_BRANCH ||
    // Netlify
    process.env.BRANCH;

  if (fromEnv) {
    return fromEnv;
  }

  // Fallback to git command
  try {
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
 * Extracts repository name from GitHub remote URL
 * Supports both HTTPS and SSH URL formats:
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 * @returns {string|null} Repository ID in format "owner/repo" if detected, null otherwise
 */
function detectGitRepoName() {
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
      /https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/
    );
    if (httpsMatch) {
      [, owner, repo] = httpsMatch;
    }

    // Parse SSH URL format: git@github.com:owner/repo.git
    const sshMatch = remoteUrl.match(
      /git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/
    );
    if (sshMatch) {
      [, owner, repo] = sshMatch;
    }

    if (owner && repo) {
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

module.exports = {
  detectGitBranch,
  detectGitRepoName,
};
