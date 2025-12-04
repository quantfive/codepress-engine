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
      serde: "=1.0.225",
      serde_json: "=1.0.140",
    },
  },

  // @swc/core 1.14+ (standalone SWC, not Next.js bundled)
  {
    id: "v48",
    swc_core: "=48.0.2",
    extra: {
      serde: "=1.0.225",
      serde_json: "=1.0.140",
      compat_feature: "compat_v48",
      swc_atoms: "=9.0.0",
    },
  },
];

// Allow selecting specific bands via env (`BAND` or `BANDS`) or CLI args.
// Examples:
//   BAND=v42 node scripts/build-swc.mjs
//   BANDS=v26,v42 node scripts/build-swc.mjs
//   node scripts/build-swc.mjs v42 v26
const cliArgs = process.argv.slice(2).filter(Boolean);
// Filter out CLI flags and their values so they don't get misinterpreted as band IDs
// Flags that take values: -n, --next, -b, --band, -t, --target, -p, --parallel
const flagsWithValues = new Set([
  "-n",
  "--next",
  "-b",
  "--band",
  "-t",
  "--target",
  "-p",
  "--parallel",
]);
const bandArgsFromCli = [];
for (let i = 0; i < cliArgs.length; i++) {
  const arg = cliArgs[i];
  if (arg.startsWith("-")) {
    // Skip flags; if it takes a value, skip the next arg too
    if (flagsWithValues.has(arg)) i++;
    continue;
  }
  bandArgsFromCli.push(arg);
}
const bandEnvRaw = process.env.BAND || process.env.BANDS || "";
const bandIdsFromEnv = bandEnvRaw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const requestedIds = [...bandIdsFromEnv, ...bandArgsFromCli];
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

  const swcCommonLine = band.extra?.swc_common
    ? `swc_common = "${band.extra.swc_common}"`
    : "";

  const swcAtomsLine = band.extra?.swc_atoms
    ? `swc_atoms = "${band.extra.swc_atoms}"`
    : "";

  const featuresBlock = band.extra?.compat_feature
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
regex = "1"
serde = { version = "${serdeVer}", features = ["derive"] }
serde_json = "${serdeJsonVer}"
${swcCommonLine}
${swcAtomsLine}

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

async function buildOneBand(band, targets = TARGETS) {
  const tmp = await mkdtemp(join(tmpdir(), `cp-swc-${band.id}-`));
  await mkdir(join(tmp, "src"), { recursive: true });
  await cp(join(CRATE_DIR, "src"), join(tmp, "src"), { recursive: true });
  await writeFile(join(tmp, "Cargo.toml"), templateCargo(band), "utf8");

  for (const t of targets) {
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

function parseArgs(argv) {
  const args = {
    next: undefined,
    band: undefined,
    target: undefined,
    parallel: 2, // number of concurrent builds, 0 = unlimited
    listBands: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--next":
      case "-n":
        args.next = argv[++i];
        break;
      case "--band":
      case "-b":
        args.band = argv[++i];
        break;
      case "--target":
      case "-t":
        args.target = argv[++i];
        break;
      case "--parallel":
      case "-p": {
        const raw = argv[++i];
        const n = Number(raw);
        if (
          raw == null ||
          !Number.isFinite(n) ||
          !Number.isInteger(n) ||
          n < 0
        ) {
          console.error(
            `[codepress] --parallel expects a non-negative integer (0 = unlimited); received: "${raw ?? ""}"`
          );
          process.exit(1);
        }
        args.parallel = n;
        break;
      }
      case "--list-bands":
        args.listBands = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        // ignore unknown for forward-compat
        break;
    }
  }
  return args;
}

async function runWithConcurrency(tasks, concurrency) {
  if (concurrency <= 0) {
    // Unlimited parallelism
    return Promise.all(tasks.map((fn) => fn()));
  }
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = Promise.resolve()
      .then(task)
      .finally(() => {
        executing.delete(p);
      });
    results.push(p);
    executing.add(p);
    if (executing.size >= concurrency) {
      try {
        await Promise.race(executing);
      } catch {
        // Swallow here; final Promise.all(results) will reject with the first error.
      }
    }
  }
  return Promise.all(results);
}

function parseSemver(input) {
  if (!input) return null;
  const m = String(input)
    .trim()
    .match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}

function nextToBandId(nextVersion) {
  const v = parseSemver(nextVersion);
  if (!v) return null;
  // Mapping guided by bands defined above
  // - Next 14.0 - 14.1  => v0_82_87
  // - Next 14.2 - 15.4  => v26
  // - Next 15.5+        => v42
  if (v.major < 14) return "v0_82_87";
  if (v.major === 14) {
    if (v.minor <= 1) return "v0_82_87";
    return "v26"; // 14.2+
  }
  if (v.major === 15) {
    if (v.minor <= 4) return "v26";
    return "v42"; // 15.5+
  }
  // Future Next versions default to latest band
  return "v42";
}

function usage() {
  console.log(
    `Usage: node scripts/build-swc.mjs [options]\n\n` +
      `Options:\n` +
      `  -n, --next <version>    Build band matching Next.js version (e.g. 15.4.0)\n` +
      `  -b, --band <id>         Build specific band id (one of: ${BANDS.map((b) => b.id).join(", ")})\n` +
      `  -t, --target <t>        Build target(s): wasip1 | wasi | all | comma-list (default: all)\n` +
      `  -p, --parallel <n>      Concurrency limit (default: 2, 0 = unlimited)\n` +
      `      --list-bands        Print available band ids and exit\n` +
      `  -h, --help              Show this help\n\n` +
      `Examples:\n` +
      `  node scripts/build-swc.mjs --next 15.4.0\n` +
      `  node scripts/build-swc.mjs --band v26 --target wasip1\n` +
      `  node scripts/build-swc.mjs --parallel 2    # Build 2 bands at a time\n` +
      `  node scripts/build-swc.mjs --parallel 0    # Build all bands in parallel\n` +
      `  npm run build:rust -- --next 15.4.0\n`
  );
}

function selectTargets(targetArg) {
  if (!targetArg || targetArg === "all") return TARGETS;
  const parts = String(targetArg)
    .split(/[,\s]+/)
    .filter(Boolean);
  const wanted = new Set(parts.map((p) => p.toLowerCase()));
  const byKey = {
    wasip1: TARGETS.find((t) => t.triple === "wasm32-wasip1"),
    wasi: TARGETS.find((t) => t.triple === "wasm32-wasi"),
  };
  const out = [];
  if (wanted.has("wasip1") && byKey.wasip1) out.push(byKey.wasip1);
  if (wanted.has("wasi") && byKey.wasi) out.push(byKey.wasi);
  if (out.length === 0) return TARGETS;
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();
    return;
  }

  if (args.listBands) {
    console.log("Available bands:");
    for (const b of BANDS) console.log(`  ${b.id} (swc_core ${b.swc_core})`);
    return;
  }

  let bands = BANDS_TO_BUILD;
  if (args.band) {
    bands = BANDS.filter((b) => b.id === args.band);
    if (bands.length === 0) {
      console.error(`[codepress] Unknown band id: ${args.band}`);
      usage();
      process.exit(1);
    }
  } else if (args.next) {
    const bandId = nextToBandId(args.next);
    if (!bandId) {
      console.error(
        `[codepress] Could not parse Next.js version: ${args.next}`
      );
      usage();
      process.exit(1);
    }
    bands = BANDS.filter((b) => b.id === bandId);
  }

  const targets = selectTargets(args.target);
  const concurrency = args.parallel;

  console.log(
    `[codepress] Building ${bands.length} band(s)` +
      (concurrency > 0
        ? ` (max ${concurrency} concurrent)`
        : " (unlimited parallelism)")
  );
  const tasks = bands.map((band) => () => buildOneBand(band, targets));
  await runWithConcurrency(tasks, concurrency);
  console.log("Finished SWC bands built.");
})();
