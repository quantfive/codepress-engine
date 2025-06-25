#!/usr/bin/env node
/* Build the SWC plugin for every ABI target we support. */
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// Define ABI versions and their compatible feature sets
// Note: Version 15 and older have API compatibility issues - can be added when resolved
const abiConfigs = [
  { version: "27.0.1", major: "27", features: ["ecma_plugin_transform"] },
  { version: "29.0.0", major: "29", features: ["ecma_plugin_transform"] },
];

const target = "wasm32-wasip1";
const outDir = path.resolve(__dirname, "..", "dist");
const pluginDir = path.join(__dirname, "..", "codepress-swc-plugin");

fs.mkdirSync(outDir, { recursive: true });

for (const config of abiConfigs) {
  console.log(
    `\n▶ building for swc_core ${config.version} (ABI ${config.major})`
  );

  // Update Cargo.toml for this specific version
  const cargoTomlPath = path.join(pluginDir, "Cargo.toml");
  let cargoToml = fs.readFileSync(cargoTomlPath, "utf8");

  // Replace the swc_core dependency line
  const newDep = `swc_core = { version = "${config.version}", default-features = false, features = ${JSON.stringify(config.features)} }`;
  cargoToml = cargoToml.replace(/swc_core = \{[^}]+\}/, newDep);
  fs.writeFileSync(cargoTomlPath, cargoToml);

  // Clean and build
  try {
    execSync("rm -f Cargo.lock", { cwd: pluginDir, stdio: "inherit" });
    execSync(`cargo build --release --target ${target}`, {
      stdio: "inherit",
      cwd: pluginDir,
    });

    const built = path.join(
      pluginDir,
      "target",
      target,
      "release",
      "codepress_swc_plugin.wasm"
    );
    const dest = path.join(outDir, `wasm-${config.major}.wasm`);
    fs.copyFileSync(built, dest);
    console.log(`→ ${dest}`);
  } catch (error) {
    console.error(
      `Failed to build for swc_core ${config.version}:`,
      error.message
    );
    process.exit(1);
  }
}

console.log("\n✅ All WASM variants built successfully!");
