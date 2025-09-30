const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

/**
 * Detects the current git branch
 * @returns {string|null} The current branch name or null if detection fails
 */
function detectGitBranch() {
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
      /https:\/\/github\.com\/([^\/]+)\/([^\/\.]+)(?:\.git)?$/,
    );
    if (httpsMatch) {
      [, owner, repo] = httpsMatch;
    }

    // Parse SSH URL format: git@github.com:owner/repo.git
    const sshMatch = remoteUrl.match(
      /git@github\.com:([^\/]+)\/([^\/\.]+)(?:\.git)?$/,
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

function pickBand() {
  // Manual overrides first
  if (process.env.CODEPRESS_SWC_WASM)
    return { wasmPath: process.env.CODEPRESS_SWC_WASM };
  if (process.env.CODEPRESS_SWC_ABI_BAND)
    return { band: process.env.CODEPRESS_SWC_ABI_BAND };

  // Try Next first
  try {
    const nextPkg = require(
      require.resolve("next/package.json", { paths: [process.cwd()] }),
    );
    const v = nextPkg.version || "";
    // very coarse bucketing by major/minor
    // Next ~13.4.10-canary.1 up to ~13.5 / early 14 → v0.79–0.81
    if (/^13\.(4|5)\./.test(v)) return { band: "v0_79_81" };
    // Next ~14.1.x (per SWC note) → v0.82–0.87
    if (/^14\.(0|1)\./.test(v)) return { band: "v0_82_87" };
    // Next 14.2+ and 15.x → modern track (we’ll default to v26 build)
    if (/^14\.(2|3|4|5)\./.test(v) || /^15\./.test(v)) return { band: "v26" };
  } catch (_) {}

  // Fallback: look at @swc/core (non-Next runners)
  try {
    const swcPkg = require(
      require.resolve("@swc/core/package.json", { paths: [process.cwd()] }),
    );
    const v = swcPkg.version || ""; // JS wrapper version
    // Old-ish @swc/core 1.3.68–1.3.80 → v0.79–0.81
    if (/^1\.3\.(6[8-9]|7\d|80)$/.test(v)) return { band: "v0_79_81" };
    // 1.3.81–1.3.105 → v0.82–0.87
    if (/^1\.3\.(8[1-9]|9\d|10[0-5])$/.test(v)) return { band: "v0_82_87" };
    // Anything newer → v26 track
    return { band: "v26" };
  } catch (_) {}

  // Last resort
  return { band: "v26" };
}

function resolveWasmFile({ band, wasmPath }) {
  // If user forces a specifier/path, just pass it through.
  if (process.env.CODEPRESS_SWC_WASM) return process.env.CODEPRESS_SWC_WASM;
  if (wasmPath) return wasmPath;

  // Return a PACKAGE EXPORT SUBPATH so Turbopack/Next can resolve it.
  // These must match your package.json "exports".
  const byBand = {
    v26: "@quantfive/codepress-engine/swc/wasm-v26",
    v0_82_87: "@quantfive/codepress-engine/swc/wasm-v0_82_87",
  };
  return byBand[band] || byBand.v26;
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

  const sel = pickBand();
  const wasm = resolveWasmFile(sel);

  const finalPath = process.env.CODEPRESS_SWC_WASM || wasm;

  // Return the plugin configuration array
  return [finalPath, config];
}

// Support both CommonJS and ES6 imports
module.exports = createSWCPlugin;
