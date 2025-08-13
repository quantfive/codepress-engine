#!/usr/bin/env node

// Codepress CLI
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { startServer } = require("./server");

// Get command line arguments
const args = process.argv.slice(2);

// Command functions
function runServer() {
  const server = startServer();
  console.log(
    "\x1b[36mℹ Codepress server running. Press Ctrl+C to stop.\x1b[0m"
  );

  // Handle process signals
  process.on("SIGINT", () => {
    console.log("\n\x1b[33mℹ Shutting down Codepress server...\x1b[0m");
    if (server) {
      server.close(() => {
        console.log("\x1b[32m✓ Codepress server stopped\x1b[0m");
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  });

  return server;
}

function setupDependencies() {
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

    // Add environment variables if they don't exist
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
    console.error(`\n\x1b[31m✗ Setup failed: ${error.message}\x1b[0m`);
    process.exit(1);
  }
}

function showHelp() {
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

// Command router
if (args.length > 0) {
  const command = args[0];

  switch (command) {
  case "server":
    runServer();
    break;

  case "setup":
    setupDependencies();
    break;

  case "help":
    showHelp();
    break;

  default: {
    // Start server and pass through all arguments to child process
    const server = startServer();

    const childProcess = spawn(args[0], args.slice(1), {
      stdio: "inherit",
      shell: true,
    });

    childProcess.on("error", (error) => {
      console.error(
        `\x1b[31m✗ Failed to start process: ${error.message}\x1b[0m`
      );
      process.exit(1);
    });

    childProcess.on("close", (code) => {
      console.log(`\x1b[33mℹ Child process exited with code ${code}\x1b[0m`);
      // Keep the server running even if the child process exits
    });

    // Handle process signals
    process.on("SIGINT", () => {
      console.log("\n\x1b[33mℹ Shutting down Codepress server...\x1b[0m");
      if (server) {
        server.close(() => {
          console.log("\x1b[32m✓ Codepress server stopped\x1b[0m");
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    });
    break;
  }
  }
} else {
  // No arguments provided, show help
  showHelp();
}
