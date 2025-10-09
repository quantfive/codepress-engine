// scripts/build-swc.mjs

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BANDS = [
  // Doesn't work (requires more shimming in rust lib)
  // Next 13.5 - 14.0
  // { id: "v0_79_81", swc_core: "=0.81.0", extra: {} },

  // Next 14.0 - 14.1
  {
    id: "v0_82_87",
    swc_core: "=0.87.0",
    extra: {
      swc_common: "=0.33.15",
      compat_feature: "compat_0_87",
      serde: "=1.0.219",
      serde_json: "=1.0.140",
    },
  },

  // Next 14.2 - 15.4
  {
    id: "v26",
    swc_core: "=26.4.5",
    extra: {
      serde: "=1.0.219",
      serde_json: "^1.0.140",
    },
  },

  // Next 15.5+
  {
    id: "v42",
    swc_core: "=42.0.3",
    extra: {
      serde: "^1.0.225",
      serde_json: "^1.0.140",
    },
  },
];

// Allow selecting specific bands via env (`BAND` or `BANDS`) or CLI args.
// Examples:
//   BAND=v42 node scripts/build-swc.mjs
//   BANDS=v26,v42 node scripts/build-swc.mjs
//   node scripts/build-swc.mjs v42 v26
const args = process.argv.slice(2).filter(Boolean);
const bandEnvRaw = process.env.BAND || process.env.BANDS || "";
const bandIdsFromEnv = bandEnvRaw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const requestedIds = [...bandIdsFromEnv, ...args];
const validIds = new Set(BANDS.map((b) => b.id));
let BANDS_TO_BUILD = BANDS;
if (requestedIds.length) {
  const unknown = requestedIds.filter((id) => !validIds.has(id));
  if (unknown.length) {
    console.error(
      `[codepress] Unknown band(s): ${unknown.join(", ")}. Valid: ${[...validIds].join(", ")}`
    );
    process.exit(1);
  }
  const requestedSet = new Set(requestedIds);
  BANDS_TO_BUILD = BANDS.filter((b) => requestedSet.has(b.id));
  console.log(
    `[codepress] Building bands: ${BANDS_TO_BUILD.map((b) => b.id).join(", ")}`
  );
} else {
  console.log(
    `[codepress] Building all bands: ${BANDS.map((b) => b.id).join(", ")}`
  );
}

// Newer Next uses WASI preview1 (“wasip1”). Some older builds still used “wasi”.
const TARGETS = [
  { triple: "wasm32-wasip1", suffix: "" }, // default
  { triple: "wasm32-wasi", suffix: ".wasi-legacy" }, // fallback for older Nexts
];

const CRATE_DIR = join(__dirname, "..", "codepress-swc-plugin");
const OUT_DIR = join(__dirname, "..", "swc");

const run = (cmd, args, opts = {}) =>
  new Promise((res, rej) =>
    execFile(cmd, args, opts, (e, stdout, stderr) =>
      e ? rej(new Error(stderr || e)) : res(stdout)
    )
  );

const templateCargo = (band) => {
  const serdeVer = band.extra?.serde ?? "=1.0.219";
  const serdeJsonVer = band.extra?.serde_json ?? "^1.0.140";

  const swcCommonLine =
    band.extra && band.extra.swc_common
      ? `swc_common = "${band.extra.swc_common}"`
      : "";

  const featuresBlock =
    band.extra && band.extra.compat_feature
      ? `

[features]
${band.extra.compat_feature} = []
default = ["${band.extra.compat_feature}"]
`
      : "";

  return `\
[package]
name = "codepress_swc_plugin"
version = "0.10.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[profile.release]
opt-level = "s"
lto = true
strip = "symbols"

[dependencies]
base64 = "0.22.1"
serde = { version = "${serdeVer}", features = ["derive"] }
serde_json = "${serdeJsonVer}"
${swcCommonLine}

[dependencies.swc_core]
version = "${band.swc_core}"
default-features = false
features = [
  "ecma_ast",
  "ecma_visit",
  "ecma_utils",
  "ecma_plugin_transform",
  "common",
  "common_sourcemap"
]
${featuresBlock}`;
};

async function hasTarget(triple) {
  const out = await run("rustc", ["--print", "target-list"]);
  return out.split(/\s+/).includes(triple);
}

async function buildOneBand(band) {
  const tmp = await mkdtemp(join(tmpdir(), `cp-swc-${band.id}-`));
  await mkdir(join(tmp, "src"), { recursive: true });
  await cp(join(CRATE_DIR, "src"), join(tmp, "src"), { recursive: true });
  await writeFile(join(tmp, "Cargo.toml"), templateCargo(band), "utf8");

  for (const t of TARGETS) {
    if (!(await hasTarget(t.triple))) {
      console.warn(
        `[codepress] Skipping ${t.triple} (rustc target not installed). Run: rustup target add ${t.triple}`
      );
      continue;
    }
    await run("cargo", ["build", "--release", "--target", t.triple], {
      cwd: tmp,
    });
    const wasm = join(
      tmp,
      "target",
      t.triple,
      "release",
      "codepress_swc_plugin.wasm"
    );
    const outName = `codepress_engine.${band.id}${t.suffix}.wasm`;
    await mkdir(OUT_DIR, { recursive: true });
    await cp(wasm, join(OUT_DIR, outName));
    console.log(`Built ${outName}`);
  }

  await rm(tmp, { recursive: true, force: true });
}

for (const band of BANDS_TO_BUILD) await buildOneBand(band);
console.log("Finished SWC bands built.");
