const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/* ---------- helpers to grab git info (unchanged) ---------- */
function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function detectGit() {
  const branch = safe(() =>
    execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim()
  );
  const remote = safe(() =>
    execSync("git config --get remote.origin.url", { encoding: "utf8" }).trim()
  );

  const match =
    remote?.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/) ?? [];
  const repo_name = match.length ? `${match[1]}/${match[2]}` : null;

  return { branch_name: branch || null, repo_name };
}

/* ---------- new: detect the host swc_core ABI major ---------- */
function hostAbiMajor() {
  try {
    // Available in @swc/core >=1.3
    const { swcCoreVersion } = require("@swc/core/binding").version();
    return swcCoreVersion.split(".")[0]; // "0", "8", "15", "27", "29"
  } catch {
    // Fallback: guess from wrapper SemVer
    const wrapper = require("@swc/core/package.json").version; // e.g. "1.11.31"
    const minor = +wrapper.split(".")[1];
    if (minor >= 12) return "29";
    if (minor >= 10) return "15";
    if (minor >= 4) return "8";
    return "0";
  }
}

/* ---------- exported factory ---------- */
module.exports = function createSWCPlugin(userConfig = {}) {
  const abi = hostAbiMajor(); // "0", "8", "15" ...
  const wasm = path.join(__dirname, `../dist/wasm-${abi}.wasm`);

  if (!fs.existsSync(wasm)) {
    throw new Error(
      `[codepress-engine] no WASM build for swc_core ABI ${abi}. ` +
        `Did CI forget to compile it?`
    );
  }

  return [
    wasm,
    {
      ...detectGit(),
      ...userConfig,
    },
  ];
};
