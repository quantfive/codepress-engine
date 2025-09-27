const { execSync } = require("child_process");

function detectGitBranch() {
  const fromEnv =
    process.env.GIT_BRANCH ||
    process.env.VERCEL_GIT_COMMIT_REF ||
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    process.env.CI_COMMIT_REF_NAME ||
    process.env.CIRCLE_BRANCH ||
    process.env.BITBUCKET_BRANCH ||
    process.env.BRANCH;

  if (fromEnv) {
    return fromEnv;
  }

  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
    }).trim();
    return branch || null;
  } catch (error) {
    return null;
  }
}

function detectGitRepoName() {
  try {
    const remoteUrl = execSync("git config --get remote.origin.url", {
      encoding: "utf8",
    }).trim();

    if (!remoteUrl) {
      return null;
    }

    let owner;
    let repo;

    const httpsMatch = remoteUrl.match(
      /https:\/\/github\.com\/([^\/]+)\/([^\/\.]+)(?:\.git)?$/
    );
    if (httpsMatch) {
      [, owner, repo] = httpsMatch;
    }

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

module.exports = {
  detectGitBranch,
  detectGitRepoName,
};
