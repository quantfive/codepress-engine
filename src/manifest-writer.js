const path = require("path");
const crypto = require("crypto");
const fetch = require("node-fetch");

const { collectManifest } = require("./component-manifest");
const { detectGitBranch, detectGitRepoName } = require("./git-info");

let lastSignature = null;
let lastOutFile = null;

const shouldWriteManifest = () => process.env.CODEPRESS_DISABLE_MANIFEST !== "1";

const resolveOutFile = (configPath) => {
  const candidate =
    configPath ||
    process.env.CODEPRESS_MANIFEST_PATH ||
    path.join(".codepress", "component-manifest.json");
  return path.resolve(process.cwd(), candidate);
};

const buildDefaultEndpoint = () => {
  if (process.env.CODEPRESS_MANIFEST_ENDPOINT) {
    return process.env.CODEPRESS_MANIFEST_ENDPOINT;
  }

  const baseUrl = process.env.CODEPRESS_BACKEND_URL;
  if (baseUrl) {
    return `${baseUrl.replace(/\/$/, "")}/v1/components/manifest`;
  }

  const host = process.env.CODEPRESS_BACKEND_HOST;
  if (!host) {
    return null;
  }

  const protocol = process.env.CODEPRESS_BACKEND_PROTOCOL || "http";
  const port = process.env.CODEPRESS_BACKEND_PORT || "8007";
  return `${protocol}://${host}:${port}/v1/components/manifest`;
};

const hashManifest = (manifest) =>
  crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");

async function postManifest(manifest, options) {
  const endpoint =
    options.endpoint ||
    process.env.CODEPRESS_MANIFEST_ENDPOINT ||
    buildDefaultEndpoint();

  if (!endpoint) {
    console.warn(
      "[codepress] Skipping manifest upload: no endpoint configured (set CODEPRESS_BACKEND_URL or CODEPRESS_MANIFEST_ENDPOINT)."
    );
    return;
  }

  const token = options.token || process.env.CODEPRESS_API_TOKEN;
  if (!token) {
    console.warn(
      "[codepress] Skipping manifest upload: CODEPRESS_API_TOKEN missing."
    );
    return;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(manifest),
    });

    if (!response.ok) {
      const body = await response.text();
      console.warn(
        `[codepress] Manifest upload failed (${response.status}): ${body}`
      );
    }
  } catch (error) {
    console.warn(
      `[codepress] Manifest upload encountered an error: ${error.message}`
    );
  }
}

async function writeManifestIfNeeded(pluginOptions = {}) {
  if (!shouldWriteManifest()) {
    return;
  }

  const manifestConfig = pluginOptions.manifest || {};
  const outFile = resolveOutFile(manifestConfig.outFile);

  const manifest = collectManifest({ outFile, silent: true });

  // Ensure repo/branch metadata always populated even if git detection fails in collectManifest.
  manifest.repoFullName =
    manifest.repoFullName || detectGitRepoName() || "unknown/unknown";
  manifest.branchName =
    manifest.branchName || detectGitBranch() || "main";

  const signature = hashManifest(manifest);
  const outFileChanged = lastOutFile !== outFile;
  const manifestChanged = signature !== lastSignature;

  lastSignature = signature;
  lastOutFile = outFile;

  const shouldPost =
    manifestConfig.post === true || process.env.CODEPRESS_POST_MANIFEST === "1";

  if (shouldPost && (manifestChanged || outFileChanged)) {
    await postManifest(manifest, manifestConfig);
  }
}

module.exports = {
  writeManifestIfNeeded,
};
