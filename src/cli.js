#!/usr/bin/env node

// Codepress CLI
const { spawn } = require('child_process');
const path = require('path');
const { startServer } = require('./server');

// Command line arguments
const args = process.argv.slice(2);
const command = args[0] || 'start';

// Start the dev server
const server = startServer();

if (command === 'start' && args.length > 1) {
  // If additional args are provided, use them as the command to run
  const userCommand = args[1];
  const userArgs = args.slice(2);
  
  console.log(`\x1b[36mℹ Starting your application with: ${userCommand} ${userArgs.join(' ')}\x1b[0m`);
  
  const childProcess = spawn(userCommand, userArgs, {
    stdio: 'inherit',
    shell: true
  });
  
  childProcess.on('error', (error) => {
    console.error(`\x1b[31m✗ Failed to start process: ${error.message}\x1b[0m`);
    process.exit(1);
  });
  
  childProcess.on('close', (code) => {
    console.log(`\x1b[33mℹ Child process exited with code ${code}\x1b[0m`);
    // Keep the server running even if the child process exits
  });
} else if (command === 'server') {
  // Just start the server and keep it running
  console.log('\x1b[36mℹ Codepress server running. Press Ctrl+C to stop.\x1b[0m');
} else {
  // If no command is provided or it's not recognized, detect package manager and run default command
  const isYarn = !!process.env.npm_config_user_agent?.includes('yarn');
  const npmCommand = isYarn ? 'yarn' : 'npm';
  const npmArgs = isYarn ? ['start'] : ['run', 'start'];
  
  console.log(`\x1b[36mℹ Starting your application with: ${npmCommand} ${npmArgs.join(' ')}\x1b[0m`);
  
  const childProcess = spawn(npmCommand, npmArgs, {
    stdio: 'inherit'
  });
  
  childProcess.on('error', (error) => {
    console.error(`\x1b[31m✗ Failed to start process: ${error.message}\x1b[0m`);
    process.exit(1);
  });
  
  childProcess.on('close', (code) => {
    console.log(`\x1b[33mℹ Child process exited with code ${code}\x1b[0m`);
    // Keep the server running even if the child process exits
  });
}

// Handle process signals
process.on('SIGINT', () => {
  console.log('\n\x1b[33mℹ Shutting down Codepress server...\x1b[0m');
  if (server) {
    server.close(() => {
      console.log('\x1b[32m✓ Codepress server stopped\x1b[0m');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});