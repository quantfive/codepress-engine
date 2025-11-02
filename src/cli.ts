#!/usr/bin/env node

import { type ChildProcess, execFileSync, spawn } from "child_process";
import type { FastifyInstance } from "fastify";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { startServer } from "./server";
import {
  previewBundle,
  type PreviewBundleResult,
} from "./previewBundle";

const args = process.argv.slice(2);
let activeServer: FastifyInstance | null = null;
let signalHandlersRegistered = false;
let currentChildProcess: ChildProcess | undefined;

async function ensureServer(): Promise<FastifyInstance | null> {
  if (activeServer) {
    return activeServer;
  }

  const server = await startServer();
  activeServer = server ?? null;

  if (activeServer) {
    console.log(
      "\x1b[36mℹ Codepress server running. Press Ctrl+C to stop.\x1b[0m"
    );
  } else {
    console.log("\x1b[33mℹ Server already running\x1b[0m");
  }

  return activeServer;
}

async function shutdown(child?: ChildProcess): Promise<void> {
  console.log("\n\x1b[33mℹ Shutting down Codepress server...\x1b[0m");

  if (child && !child.killed) {
    child.kill("SIGINT");
  }

  if (activeServer) {
    try {
      await activeServer.close();
      console.log("\x1b[32m✓ Codepress server stopped\x1b[0m");
    } catch (error) {
      console.error(
        `\x1b[31m✗ Failed to stop server: ${(error as Error).message}\x1b[0m`
      );
    } finally {
      activeServer = null;
    }
  }

  // Best-effort: remove lock if owned by this process
  try {
    const port = parseInt(process.env.CODEPRESS_DEV_PORT || "4321", 10);
    const suffix = isFinite(port) ? `-${port}` : "";
    const lockPath = path.join(
      os.tmpdir(),
      `codepress-dev-server${suffix}.lock`
    );
    if (fs.existsSync(lockPath)) {
      const raw = fs.readFileSync(lockPath, "utf8");
      const data: { pid?: number } = JSON.parse(raw);
      if (data && data.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch {
    // ignore
  }

  process.exit(0);
}

function registerSignalHandlers(child?: ChildProcess): void {
  currentChildProcess = child;

  if (signalHandlersRegistered) {
    return;
  }

  const handler = () => {
    void shutdown(currentChildProcess);
  };

  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  signalHandlersRegistered = true;
}

function setupDependencies(): void {
  console.log(
    "\x1b[36mℹ Setting up dependencies for Codepress visual editor...\x1b[0m"
  );

  try {
    console.log("\x1b[36mℹ Installing dependencies...\x1b[0m");
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    execFileSync(
      npmCmd,
      ["install", "--save", "prettier@^3.1.0", "node-fetch@^2.6.7"],
      { stdio: "inherit" }
    );

    console.log("\n\x1b[36mℹ Setting up environment variables...\x1b[0m");
    const envFile = path.join(process.cwd(), ".env");

    let envContent = "";
    if (fs.existsSync(envFile)) {
      envContent = fs.readFileSync(envFile, "utf8");
    }

    let envUpdated = false;

    if (!envContent.includes("CODEPRESS_BACKEND_HOST")) {
      envContent += "\n# Codepress backend settings\n";
      envContent += "CODEPRESS_BACKEND_HOST=localhost\n";
      envContent += "CODEPRESS_BACKEND_PORT=8007\n";
      envUpdated = true;
    }

    if (!envContent.includes("CODEPRESS_API_TOKEN")) {
      envContent += "\n# Codepress authentication\n";
      envContent += "# Get this from your organization settings in Codepress\n";
      envContent += "CODEPRESS_API_TOKEN=\n";
      envUpdated = true;
    }

    if (envUpdated) {
      fs.writeFileSync(envFile, envContent);
      console.log("\x1b[32m✓ Added Codepress settings to .env file\x1b[0m");
      console.log(
        "\x1b[33m⚠ Please set your CODEPRESS_API_TOKEN in the .env file\x1b[0m"
      );
    }

    console.log("\n\x1b[32m✅ Setup completed successfully!\x1b[0m");
    console.log(
      "\x1b[36mℹ You can now start the server with: npx codepress server\x1b[0m"
    );
  } catch (error) {
    console.error(
      `\n\x1b[31m✗ Setup failed: ${(error as Error).message}\x1b[0m`
    );
    process.exit(1);
  }
}

function showHelp(): void {
  console.log(`
\x1b[1mCodepress CLI\x1b[0m

\x1b[1mUsage:\x1b[0m
  codepress [command] [args...]

\x1b[1mCommands:\x1b[0m
  server          Start the development server
  setup           Setup dependencies for the visual editor
  preview-bundle  Bundle entries for Codepress preview
  <command>       Run any command with the server running in background
  help            Show this help message

\x1b[1mExamples:\x1b[0m
  codepress server              Start the server only
  codepress setup               Install required dependencies
  codepress npm start           Run npm start with server in background
  codepress preview-bundle --entry src/components/Button.tsx --json
  `);
}

interface PreviewBundleCLIOptions {
  entries: string[];
  repoName?: string;
  branchName?: string;
  tsconfigPath?: string;
  json: boolean;
}

function parsePreviewBundleArgs(args: string[]): PreviewBundleCLIOptions {
  const entries: string[] = [];
  let repoName: string | undefined;
  let branchName: string | undefined;
  let tsconfigPath: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--entry" || arg === "-e") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("--entry requires a value");
      }
      entries.push(value);
      i += 1;
    } else if (arg.startsWith("--entry=")) {
      entries.push(arg.slice("--entry=".length));
    } else if (arg === "--repo-name") {
      repoName = args[i + 1];
      if (!repoName) throw new Error("--repo-name requires a value");
      i += 1;
    } else if (arg.startsWith("--repo-name=")) {
      repoName = arg.slice("--repo-name=".length);
    } else if (arg === "--branch-name") {
      branchName = args[i + 1];
      if (!branchName) throw new Error("--branch-name requires a value");
      i += 1;
    } else if (arg.startsWith("--branch-name=")) {
      branchName = arg.slice("--branch-name=".length);
    } else if (arg === "--tsconfig") {
      tsconfigPath = args[i + 1];
      if (!tsconfigPath) throw new Error("--tsconfig requires a value");
      i += 1;
    } else if (arg.startsWith("--tsconfig=")) {
      tsconfigPath = arg.slice("--tsconfig=".length);
    } else if (arg === "--json") {
      json = true;
    } else if (!arg.startsWith("-")) {
      entries.push(arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { entries, repoName, branchName, tsconfigPath, json };
}

function printPreviewBundleResult(
  result: PreviewBundleResult,
  json: boolean
): void {
  if (json) {
    process.stdout.write(JSON.stringify(result));
    return;
  }
  for (const mod of result.modules) {
    if (mod.error) {
      console.error(`✗ ${mod.entry} (${mod.error}): ${mod.buildError ?? ""}`);
    } else {
      console.log(`✓ ${mod.entry}`);
      if (mod.warnings.length) {
        for (const warning of mod.warnings) {
          console.warn(`  warning: ${warning}`);
        }
      }
    }
  }
}

async function main(): Promise<void> {
  if (args.length === 0) {
    showHelp();
    return;
  }

  const [command, ...rest] = args;

  switch (command) {
    case "preview-bundle": {
      let parsed: PreviewBundleCLIOptions;
      try {
        parsed = parsePreviewBundleArgs(rest);
      } catch (error) {
        console.error(
          `\x1b[31m✗ ${(error as Error).message}\x1b[0m`
        );
        process.exit(1);
        return;
      }
      if (parsed.entries.length === 0) {
        console.error(
          "\x1b[31m✗ preview-bundle requires at least one --entry\x1b[0m"
        );
        process.exit(1);
      }
      try {
        const result = await previewBundle({
          entries: parsed.entries,
          absWorkingDir: process.cwd(),
          repoName: parsed.repoName,
          branchName: parsed.branchName,
          tsconfigPath: parsed.tsconfigPath,
          quiet: parsed.json,
        });
        printPreviewBundleResult(result, parsed.json);
        const hasError = result.modules.some((mod) => mod.error);
        if (hasError) {
          process.exit(1);
        }
      } catch (error) {
        console.error(
          `\x1b[31m✗ ${(error as Error).message}\x1b[0m`
        );
        process.exit(1);
      }
      break;
    }
    case "server": {
      const server = await ensureServer();
      registerSignalHandlers();
      if (!server) {
        console.log(
          "\x1b[33mℹ Server already running in another process\x1b[0m"
        );
      }
      break;
    }
    case "setup":
      setupDependencies();
      break;
    case "help":
      showHelp();
      break;
    default: {
      await ensureServer();

      const childProcess = spawn(command, rest, {
        stdio: "inherit",
        shell: true,
      });

      childProcess.on("error", (error) => {
        console.error(
          `\x1b[31m✗ Failed to start process: ${(error as Error).message}\x1b[0m`
        );
        void shutdown(childProcess);
      });

      childProcess.on("close", (code) => {
        console.log(`\x1b[33mℹ Child process exited with code ${code}\x1b[0m`);
      });

      registerSignalHandlers(childProcess);
      break;
    }
  }
}

void main();
