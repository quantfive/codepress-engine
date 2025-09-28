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
  if (host) {
    const protocol = process.env.CODEPRESS_BACKEND_PROTOCOL || "http";
    const port = process.env.CODEPRESS_BACKEND_PORT || "8007";
    return `${protocol}://${host}:${port}/v1/components/manifest`;
  }

  const defaultHost = process.env.CODEPRESS_DEFAULT_BACKEND_HOST || "localhost";
  const defaultPort = process.env.CODEPRESS_DEFAULT_BACKEND_PORT || "8007";
  return `http://${defaultHost}:${defaultPort}/v1/components/manifest`;
};

const hashManifest = (manifest) =>
  crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");

const logManifestPreview = (manifest) => {
  try {
    const preview = {
      repoFullName: manifest.repoFullName,
      branchName: manifest.branchName,
      entriesCount: Array.isArray(manifest.entries) ? manifest.entries.length : 0,
      entriesSample: (manifest.entries || []).slice(0, 5),
    };
    console.warn(
      `[codepress] Manifest payload preview: ${JSON.stringify(preview, null, 2)}`
    );
  } catch (err) {
    console.warn(`[codepress] Failed to log manifest preview: ${err.message}`);
  }
};

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
      logManifestPreview(manifest);
    }
  } catch (error) {
    console.warn(
      `[codepress] Manifest upload encountered an error: ${error.message}`
    );
    logManifestPreview(manifest);
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
