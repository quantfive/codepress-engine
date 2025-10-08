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

function runtimeIsAvailable() {
  try {
    require.resolve("react", { paths: [process.cwd()] });
    require.resolve("react-dom", { paths: [process.cwd()] });
    require.resolve("@quantfive/codepress-engine/runtime", { paths: [process.cwd()] });
    return true;
  } catch {
    return false;
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
    // Next 15.5+ → v42 (runner 18.x / swc_core 42.x)
    if (/^15\.(5|[6-9]|\d{2,})\./.test(v)) return { band: "v42" };
    // Next 14.2–15.4 → v26
    if (/^(14\.(2|3|4|5)\.|15\.(0|1|2|3|4)\.)/.test(v)) return { band: "v26" };
    // Next 14.0–14.1 → v0.82–0.87
    if (/^14\.(0|1)\./.test(v)) return { band: "v0_82_87" };
    // very coarse bucketing by major/minor
    // // Next 13.4-14.1 → v0.79–0.81
    // if (/^13\.(4|5)\./.test(v)) return { band: "v0_79_81" };
  } catch (_) {}

  // Fallback: look at @swc/core (non-Next runners)
  try {
    const swcPkg = require(
      require.resolve("@swc/core/package.json", { paths: [process.cwd()] }),
    );
    const v = String(swcPkg.version || "0.0.0");

    // Tiny semver compare: returns -1, 0, 1
    const cmp = (a, b) => {
      const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
      const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
      for (let i = 0; i < 3; i++) {
        if (pa[i] < pb[i]) return -1;
        if (pa[i] > pb[i]) return 1;
      }
      return 0;
    };
    const gte = (x, y) => cmp(x, y) >= 0;
    const lte = (x, y) => cmp(x, y) <= 0;
    const lt = (x, y) => cmp(x, y) < 0;

    // Buckets:
    // - 1.3.81 .. 1.3.105  → swc_core 0.82–0.87 ABI (band v0_82_87)
    // - 1.3.106 .. 1.10.x  → swc_core 26.x ABI (band v26)
    // - 1.11.0+            → swc_core 42.x ABI (band v42)
    if (gte(v, "1.3.81") && lte(v, "1.3.105")) {
      return { band: "v0_82_87" };
    }
    if (gte(v, "1.3.106") && lt(v, "1.11.0")) {
      return { band: "v26" };
    }
    // 1.11.0 and newer
    return { band: "v42" };
  } catch (_) {}

  // Last resort
  return { band: "v42" };
}

function resolveWasmFile({ band, wasmPath }) {
  // If user forces a specifier/path, allow only absolute paths or package specifiers.
  const forced = process.env.CODEPRESS_SWC_WASM || wasmPath;
  if (forced) {
    // Accept package specifiers (e.g. @quantfive/codepress-engine/swc/wasm-v26)
    // or absolute paths. Reject relative paths (Turbopack cannot import them here).
    if (/^@/.test(forced) || forced.startsWith("/")) return forced;
    console.warn(
      "[codepress] Ignoring relative CODEPRESS_SWC_WASM. Use a package export (e.g. @quantfive/codepress-engine/swc/wasm-v26) or an absolute path.",
    );
  }

  // Always return a PACKAGE EXPORT SUBPATH so Turbopack/Next can resolve it.
  // These MUST match package.json "exports".
  const byBand = {
    v0_82_87: "@quantfive/codepress-engine/swc/wasm-v0_82_87",
    v26: "@quantfive/codepress-engine/swc/wasm-v26",
    v42: "@quantfive/codepress-engine/swc/wasm-v42",
  };
  return byBand[band] || byBand.v42;
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

  const auto = runtimeIsAvailable();

  const finalPath = wasm;

  // Return the plugin configuration array
  return [finalPath, config];
}

// Support both CommonJS and ES6 imports
module.exports = createSWCPlugin;
