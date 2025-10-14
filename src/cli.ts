#!/usr/bin/env node

import { type ChildProcess, execSync, spawn } from "child_process";
import type { FastifyInstance } from "fastify";
import * as fs from "node:fs";
import * as path from "node:path";

import { startServer } from "./server";

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
    execSync("npm install --save prettier@^3.1.0 node-fetch@^2.6.7", {
      stdio: "inherit",
    });

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
  <command>       Run any command with the server running in background
  help            Show this help message

\x1b[1mExamples:\x1b[0m
  codepress server              Start the server only
  codepress setup               Install required dependencies
  codepress npm start           Run npm start with server in background
  `);
}

async function main(): Promise<void> {
  if (args.length === 0) {
    showHelp();
    return;
  }

  const [command, ...rest] = args;

  switch (command) {
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
