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
    // TODO: clean this up to be correct
    const v = swcPkg.version || ""; // JS wrapper version
    // // Old-ish @swc/core 1.3.68–1.3.80 → v0.79–0.81
    // if (/^1\.3\.(6[8-9]|7\d|80)$/.test(v)) return { band: "v0_79_81" };
    // 1.3.81–1.3.105 → v0.82–0.87
    if (/^1\.3\.(8[1-9]|9\d|10[0-5])$/.test(v)) return { band: "v0_82_87" };
    // TODO: determine what swc version are v26
    // return { band: "v26" };
    return { band: "v42" };
  } catch (_) {}

  // Last resort
  return { band: "v42" };
}

function resolveWasmFile({ band, wasmPath }) {
  // If user forces a specifier/path, just pass it through.
  if (process.env.CODEPRESS_SWC_WASM) {
    const abs = process.env.CODEPRESS_SWC_WASM;
    // Prefer a CWD-relative POSIX path so Turbopack can import it.
    const rel =
      "./" +
      path.posix.normalize(
        path.relative(process.cwd(), abs).split(path.sep).join("/"),
      );
    return rel;
  }
  if (wasmPath) {
    const rel =
      "./" +
      path.posix.normalize(
        path.relative(process.cwd(), wasmPath).split(path.sep).join("/"),
      );
    return rel;
  }

  // Map to export subpaths (must match package.json "exports"), then
  // resolve to an ABSOLUTE FILE PATH for the Node-side runner.
  const byBand = {
    v0_82_87: "@quantfive/codepress-engine/swc/wasm-v0_82_87",
    v26: "@quantfive/codepress-engine/swc/wasm-v26",
    v42: "@quantfive/codepress-engine/swc/wasm-v42",
  };
  const spec = byBand[band] || byBand.v42;
  // Resolve the export to a physical file so we can hand Turbopack a relative path.
  try {
    const abs = require.resolve(spec, { paths: [process.cwd()] });
    const rel =
      "./" +
      path.posix.normalize(
        path.relative(process.cwd(), abs).split(path.sep).join("/"),
      );
    return rel;
  } catch {
    // Last-resort: try local files directly (useful for `pnpm link` / tgz installs)
    for (const base of [
      "codepress_engine.v42",
      "codepress_engine.v26",
      "codepress_engine.v0_82_87",
    ]) {
      for (const suffix of ["", ".wasi-legacy"]) {
        const p = path.join(__dirname, base + suffix + ".wasm");
        if (fs.existsSync(p)) {
          const rel =
            "./" +
            path.posix.normalize(
              path.relative(process.cwd(), p).split(path.sep).join("/"),
            );
          return rel;
        }
      }
    }
    // If all else fails, return the specifier (older Next may resolve it).
    return spec;
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

  const sel = pickBand();
  const wasm = resolveWasmFile(sel);

  const finalPath = process.env.CODEPRESS_SWC_WASM || wasm;

  // Return the plugin configuration array
  return [finalPath, config];
}

// Support both CommonJS and ES6 imports
module.exports = createSWCPlugin;
