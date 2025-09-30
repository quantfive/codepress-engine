// scripts/build-swc.mjs
import { mkdir, mkdtemp, readFile, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
const __dirname = dirname(fileURLToPath(import.meta.url));

const BANDS = [
  // Doesn't work (can probably fix with shim)
  // // v0.79–0.81 (Next 13.4.10-canary.1 → around 13.5 / early 14)
  // { id: "v0_79_81", swc_core: "=0.81.0", extra: {} },

  // v0.82–0.87 (Next ~14.1.0 timeframe; requires swc_common pin per docs)
  {
    id: "v0_82_87",
    swc_core: "=0.87.0",
    extra: { swc_common: "=0.33.15", compat_feature: "compat_0_87" },
  },

  // Modern (today’s Next 14.2+ / 15 often use newer tracks; keep one “latest” too)
  { id: "v26", swc_core: "=26.4.5", extra: {} },
];

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
      e ? rej(new Error(stderr || e)) : res(stdout),
    ),
  );

const templateCargo = (band) => {
  const swcCommonLine =
    band.extra && band.extra.swc_common
      ? `swc_common = "${band.extra.swc_common}"`
      : "";

  // Always declare the compat feature to silence cfg warnings on bands that don't enable it.
  // Only enable it by default for the legacy band (0.82–0.87).
  const defaultFeatures =
    band.extra && band.extra.compat_feature
      ? `default = ["${band.extra.compat_feature}"]`
      : `default = []`;

  const featuresBlock = `

[features]
compat_0_87 = []
${defaultFeatures}
`;

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
serde = { version = "=1.0.219", features = ["derive"] }
serde_json = "=1.0.140"
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
        `[codepress] Skipping ${t.triple} (rustc target not installed). Run: rustup target add ${t.triple}`,
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
      "codepress_swc_plugin.wasm",
    );
    const outName = `codepress_engine.${band.id}${t.suffix}.wasm`;
    await mkdir(OUT_DIR, { recursive: true });
    await cp(wasm, join(OUT_DIR, outName));
    console.log(`Built ${outName}`);
  }

  await rm(tmp, { recursive: true, force: true });
}

for (const band of BANDS) await buildOneBand(band);
console.log("Finished SWC bands built.");
