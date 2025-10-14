import { execSync } from "child_process";

type Band = "v0_82_87" | "v26" | "v42";

interface BandSelection {
  band?: Band;
  wasmPath?: string;
}

interface SWCUserConfig extends Record<string, unknown> {}

interface SWCConfig extends SWCUserConfig {
  repo_name: string | null;
  branch_name: string | null;
}

const PACKAGE_SCOPE = "@quantfive/codepress-engine";

function readGitOutput(command: string): string | null {
  try {
    return execSync(command, { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function detectGitBranch(): string | null {
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

  return readGitOutput("git rev-parse --abbrev-ref HEAD");
}

function detectGitRepoName(): string | null {
  const remoteUrl = readGitOutput("git config --get remote.origin.url");
  if (!remoteUrl) {
    return null;
  }

  const httpsMatch = remoteUrl.match(
    /https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/
  );
  if (httpsMatch) {
    const [, owner, repo] = httpsMatch;
    return `${owner}/${repo}`;
  }

  const sshMatch = remoteUrl.match(
    /git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/
  );
  if (sshMatch) {
    const [, owner, repo] = sshMatch;
    return `${owner}/${repo}`;
  }

  return null;
}

function readPackageVersion(pkg: string): string | null {
  try {
    const resolved = require(
      require.resolve(`${pkg}/package.json`, { paths: [process.cwd()] })
    ) as { version?: string };
    return resolved.version ?? null;
  } catch {
    return null;
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((segment) => parseInt(segment, 10) || 0);
  const pb = b.split(".").map((segment) => parseInt(segment, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

function pickBand(): BandSelection {
  if (process.env.CODEPRESS_SWC_WASM) {
    return { wasmPath: process.env.CODEPRESS_SWC_WASM };
  }

  if (process.env.CODEPRESS_SWC_ABI_BAND) {
    return { band: process.env.CODEPRESS_SWC_ABI_BAND as Band };
  }

  const nextVersion = readPackageVersion("next");
  if (nextVersion) {
    if (/^15\.(5|[6-9]|\d{2,})\./.test(nextVersion)) {
      return { band: "v42" };
    }
    if (/^(14\.(2|3|4|5)\.|15\.(0|1|2|3|4)\.)/.test(nextVersion)) {
      return { band: "v26" };
    }
    if (/^14\.(0|1)\./.test(nextVersion)) {
      return { band: "v0_82_87" };
    }
  }

  const swcVersion = readPackageVersion("@swc/core") ?? "0.0.0";
  if (
    compareSemver(swcVersion, "1.3.81") >= 0 &&
    compareSemver(swcVersion, "1.3.105") <= 0
  ) {
    return { band: "v0_82_87" };
  }

  if (
    compareSemver(swcVersion, "1.3.106") >= 0 &&
    compareSemver(swcVersion, "1.11.0") < 0
  ) {
    return { band: "v26" };
  }

  return { band: "v42" };
}

function resolveWasmFile(selection: BandSelection): string {
  const forced = process.env.CODEPRESS_SWC_WASM ?? selection.wasmPath;
  if (forced) {
    if (forced.startsWith("@") || forced.startsWith("/")) {
      return forced;
    }
    console.warn(
      "[codepress] Ignoring relative CODEPRESS_SWC_WASM. Use a package export (e.g. @quantfive/codepress-engine/swc/wasm-v26) or an absolute path."
    );
  }

  const bandToSpecifier: Record<Band, string> = {
    v0_82_87: `${PACKAGE_SCOPE}/swc/wasm-v0_82_87`,
    v26: `${PACKAGE_SCOPE}/swc/wasm-v26`,
    v42: `${PACKAGE_SCOPE}/swc/wasm-v42`,
  };

  return bandToSpecifier[selection.band ?? "v42"];
}

const createSWCPlugin = (
  userConfig: SWCUserConfig = {}
): [string, SWCConfig] => {
  const config: SWCConfig = {
    repo_name: detectGitRepoName(),
    branch_name: detectGitBranch(),
    ...userConfig,
  };

  const wasmSpecifier = resolveWasmFile(pickBand());
  return [wasmSpecifier, config];
};

export { createSWCPlugin, pickBand, resolveWasmFile };
export type { SWCConfig };
export default createSWCPlugin;
