// Codepress Dev Server
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const prettier = require("prettier");
const fetch = require("node-fetch");
const { decode } = require("./index");

/**
 * Gets the port to use for the server
 * @returns {number} The configured port
 */
function getServerPort() {
  // Use environment variable or default to 4321
  return parseInt(process.env.CODEPRESS_DEV_PORT || "4321", 10);
}

/**
 * Create a lock file to ensure only one instance runs
 * @returns {boolean} True if lock was acquired, false otherwise
 */
function acquireLock() {
  try {
    const lockPath = path.join(os.tmpdir(), "codepress-dev-server.lock");

    // Try to read the lock file to check if the server is already running
    const lockData = fs.existsSync(lockPath)
      ? JSON.parse(fs.readFileSync(lockPath, "utf8"))
      : null;

    if (lockData) {
      // Check if the process in the lock file is still running
      try {
        // On Unix-like systems, sending signal 0 checks if process exists
        process.kill(lockData.pid, 0);
        // Process exists, lock is valid
        return false;
      } catch (e) {
        // Process doesn't exist, lock is stale
        // Continue to create a new lock
      }
    }

    // Create a new lock file
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        timestamp: Date.now(),
      })
    );

    return true;
  } catch (err) {
    // If anything fails, assume we couldn't get the lock
    return false;
  }
}

// Track server instance (singleton pattern)
let serverInstance = null;

/**
 * Apply text-based changes to the file content directly based on the new format.
 * @param {string} fileContent The original file content
 * @param {Array<Object>} changes The changes to apply in the new format.
 *        Each change object can have:
 *        - { type: "insert", line: number, codeChange: string }
 *        - { type: "delete", startLine: number, endLine: number }
 *        - { type: "replace", startLine: number, endLine: number, codeChange: string }
 * @returns {string} The modified file content
 */
function applyTextChanges(fileContent, changes) {
  const lines = fileContent.split("\n");

  // Sort changes by the highest line number involved (endLine or line) in reverse order
  // to avoid index shifts during modification.
  const sortedChanges = [...changes].sort((a, b) => {
    const lineA = a.type === "insert" ? a.line : a.endLine;
    const lineB = b.type === "insert" ? b.line : b.endLine;
    return lineB - lineA;
  });

  for (const change of sortedChanges) {
    const { type } = change;

    // Convert line numbers to 0-based indices for array operations
    const startIdx = change.startLine ? change.startLine - 1 : undefined;
    const endIdx = change.endLine ? change.endLine - 1 : undefined;
    const lineIdx = change.line ? change.line - 1 : undefined; // For insert

    switch (type) {
      case "replace":
        if (
          startIdx !== undefined &&
          endIdx !== undefined &&
          change.codeChange !== undefined
        ) {
          // Decode newline characters within the codeChange string
          const decodedCodeChange = change.codeChange.replace(/\\n/g, "\n");
          const replacementLines = decodedCodeChange.split("\n");
          lines.splice(startIdx, endIdx - startIdx + 1, ...replacementLines);
        } else {
          console.warn("Invalid 'replace' change object:", change);
        }
        break;

      case "delete":
        if (startIdx !== undefined && endIdx !== undefined) {
          lines.splice(startIdx, endIdx - startIdx + 1);
        } else {
          console.warn("Invalid 'delete' change object:", change);
        }
        break;

      case "insert":
        if (lineIdx !== undefined && change.codeChange !== undefined) {
          // Decode newline characters within the codeChange string
          const decodedCodeChange = change.codeChange.replace(/\\n/g, "\n");
          // Insert *after* the specified line index
          const insertionLines = decodedCodeChange.split("\n");
          lines.splice(lineIdx + 1, 0, ...insertionLines);
        } else {
          console.warn("Invalid 'insert' change object:", change);
        }
        break;

      default:
        console.warn(`Unknown change type: ${type}`);
    }
  }

  return lines.join("\n");
}

/**
 * Make an HTTP request to the FastAPI backend using fetch
 * @param {string} method The HTTP method
 * @param {string} endpoint The API endpoint
 * @param {Object} data The request payload
 * @param {string} incomingAuthHeader The incoming Authorization header
 * @returns {Promise<Object>} The response data
 */
async function callBackendApi(method, endpoint, data, incomingAuthHeader) {
  // Backend API settings
  const apiHost = process.env.CODEPRESS_BACKEND_HOST || "localhost";
  const apiPort = parseInt(process.env.CODEPRESS_BACKEND_PORT || "8000", 10);
  const apiPath = endpoint.startsWith("/")
    ? endpoint.replace("/", "")
    : endpoint;

  // Build the complete URL - detect if using localhost for HTTP, otherwise use HTTPS
  const protocol =
    apiHost === "localhost" || apiHost === "127.0.0.1" ? "http" : "https";
  console.log(`\x1b[36mℹ API Path: ${apiPath} \x1b[0m`);
  const url = `${protocol}://${apiHost}${apiPort ? `:${apiPort}` : ""}/api/${apiPath}`;
  console.log(`\x1b[36mℹ Sending request to ${url} \x1b[0m`);

  try {
    // First try to use API token from environment variable
    let authToken = process.env.CODEPRESS_API_TOKEN;

    // If no API token, try to use the incoming Authorization header
    if (!authToken && incomingAuthHeader) {
      authToken = incomingAuthHeader.split(" ")[1]; // Extract token part
      console.log(
        `\x1b[36mℹ Using incoming Authorization header for authentication\x1b[0m`
      );
    }

    // Prepare headers with authentication if token exists
    const headers = {
      "Content-Type": "application/json",
    };

    if (authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
      // Log which auth method we're using (but don't expose the actual token)
      console.log(
        `\x1b[36mℹ Using ${process.env.CODEPRESS_API_TOKEN ? "API Token" : "GitHub OAuth Token"} for authentication\x1b[0m`
      );
    } else {
      console.log("\x1b[33m⚠ No authentication token available\x1b[0m");
    }

    const response = await fetch(url, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });

    // Get the response text
    const responseText = await response.text();

    // Check if response is successful
    if (!response.ok) {
      throw new Error(
        `API request failed with status ${response.status}: ${responseText}`
      );
    }

    // Try to parse the response as JSON
    try {
      return JSON.parse(responseText);
    } catch (err) {
      throw new Error(`Invalid JSON response: ${err.message}`);
    }
  } catch (err) {
    // Handle network errors and other issues
    if (err.name === "FetchError") {
      throw new Error(`Network error: ${err.message}`);
    }

    // Re-throw the original error
    throw err;
  }
}

/**
 * Starts the Codepress development server if not already running
 * @param {Object} options Server configuration options
 * @param {number} [options.port=4321] Port to run the server on
 * @returns {http.Server|null} The server instance or null if already running
 */
function startServer(options = {}) {
  // Only run in development environment
  if (process.env.NODE_ENV === "production") {
    return null;
  }

  // Return existing instance if already running
  if (serverInstance) {
    return serverInstance;
  }

  // Try to acquire lock to ensure only one server instance runs system-wide
  if (!acquireLock()) {
    return null;
  }

  // Get the fixed port
  const port = options.port || getServerPort();

  // Create server
  let server;
  try {
    server = http.createServer((req, res) => {
      // Add CORS headers for all responses
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS, PUT, PATCH, DELETE"
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "X-Requested-With,content-type,Authorization"
      );
      res.setHeader("Access-Control-Allow-Credentials", "true");

      // Handle preflight OPTIONS request
      if (req.method === "OPTIONS") {
        res.statusCode = 204; // No content
        res.end();
        return;
      }
      // Simple request handling
      if (req.url === "/ping") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain");
        res.end("pong");
      } else if (req.url === "/meta") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        // Try to get package version but don't fail if not available
        let version = "0.0.0";
        try {
          // In production builds, use a relative path that works with the installed package structure
          version = require("../package.json").version;
        } catch (e) {
          // Ignore error, use default version
        }

        res.end(
          JSON.stringify({
            name: "Codepress Dev Server",
            version: version,
            environment: process.env.NODE_ENV || "development",
            uptime: process.uptime(),
          })
        );
      } else if (req.url === "/visual-editor-api" && req.method === "POST") {
        // Handle API requests for getting changes from the backend and applying them
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });

        req.on("end", async () => {
          try {
            const data = JSON.parse(body);
            // Use snake_case consistently - the frontend might send camelCase or snake_case
            const {
              encoded_location,
              old_html,
              new_html,
              github_repo_name,
              mode,
              aiInstruction,
              ai_instruction,
            } = data;
            // Use ai_instruction if provided, otherwise use aiInstruction
            const actualAiInstruction = ai_instruction || aiInstruction;

            // Debug logging to see what's being received
            console.log(
              `\x1b[36mℹ Request data: ${JSON.stringify({
                encoded_location,
                old_html: old_html ? "[present]" : undefined,
                new_html: new_html ? "[present]" : undefined,
                mode,
                aiInstruction: actualAiInstruction ? "[present]" : undefined,
              })}\x1b[0m`
            );

            // Validate required fields based on the mode
            const isAiMode = mode === "max";

            if (!encoded_location) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  error: "Missing encoded_location field",
                  encoded_location: encoded_location || undefined,
                })
              );
              return;
            }

            if (isAiMode) {
              // AI mode validation
              if (!actualAiInstruction) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(
                  JSON.stringify({
                    error: "Missing aiInstruction field in AI mode",
                    encoded_location,
                    mode,
                  })
                );
                return;
              }
            } else {
              // Regular mode validation
              const missingFields = [];
              if (!old_html) missingFields.push("old_html");
              if (!new_html) missingFields.push("new_html");

              if (missingFields.length > 0) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(
                  JSON.stringify({
                    error: `Missing required fields: ${missingFields.join(", ")}`,
                    encoded_location,
                    missingFields,
                  })
                );
                return;
              }
            }

            try {
              const incomingAuthHeader = req.headers["authorization"];

              const encodedFilePath = encoded_location.split(":")[0];
              const filePath = decode(encodedFilePath);
              console.log(`\x1b[36mℹ Decoded file path: ${filePath}\x1b[0m`);
              const targetFile = path.join(process.cwd(), filePath);
              console.log(`\x1b[36mℹ Reading file: ${targetFile}\x1b[0m`);
              const fileContent = fs.readFileSync(targetFile, "utf8");

              // Determine if this is an AI-based request (CodePress Max mode)
              const isAiMode = data.mode === "max";

              let backendResponse;

              if (isAiMode) {
                // Call backend API for AI-based changes
                console.log(
                  `\x1b[36mℹ Getting AI changes from backend for file encoded_location: ${encoded_location}\x1b[0m`
                );
                console.log(
                  `\x1b[36mℹ AI Instruction: ${actualAiInstruction}\x1b[0m`
                );

                backendResponse = await callBackendApi(
                  "POST",
                  "code-sync/get-ai-changes",
                  {
                    encoded_location,
                    ai_instruction: actualAiInstruction,
                    file_content: fileContent,
                    github_repo_name,
                  },
                  incomingAuthHeader
                );
              } else {
                // Call regular backend API to get HTML-based changes
                console.log(
                  `\x1b[36mℹ Getting HTML changes from backend for file encoded_location: ${encoded_location}\x1b[0m`
                );

                backendResponse = await callBackendApi(
                  "POST",
                  "code-sync/get-changes",
                  {
                    old_html,
                    new_html,
                    github_repo_name,
                    encoded_location,
                    file_content: fileContent,
                  },
                  incomingAuthHeader
                );
              }

              console.log(`\x1b[36mℹ Received response from backend\x1b[0m`);

              if (
                !backendResponse.changes ||
                !Array.isArray(backendResponse.changes)
              ) {
                console.error(
                  `\x1b[31m✗ Invalid response format: ${JSON.stringify(backendResponse)}\x1b[0m`
                );
                throw new Error("Invalid response format from backend");
              }

              const changes = backendResponse.changes;
              console.log(
                `\x1b[36mℹ Received ${changes.length} changes from backend\x1b[0m`
              );

              // File content already loaded from above

              // Apply the changes
              const modifiedContent = applyTextChanges(fileContent, changes);

              // Format with Prettier
              let formattedCode;
              try {
                formattedCode = await prettier.format(modifiedContent, {
                  parser: "typescript",
                  semi: true,
                  singleQuote: false,
                });
              } catch (prettierError) {
                console.error("Prettier formatting failed:", prettierError);
                // If formatting fails, use the unformatted code
                formattedCode = modifiedContent;
              }

              // Write back to file
              fs.writeFileSync(targetFile, formattedCode, "utf8");

              console.log(
                `\x1b[32m✓ Updated file ${targetFile} with ${changes.length} changes\x1b[0m`
              );

              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json");

              // Include the modified content in the response for AI mode
              if (isAiMode) {
                res.end(
                  JSON.stringify({
                    success: true,
                    message: `Applied ${changes.length} AI-suggested changes to ${filePath}`,
                    modified_content: formattedCode,
                  })
                );
              } else {
                res.end(
                  JSON.stringify({
                    success: true,
                    message: `Applied ${changes.length} changes to ${filePath}`,
                  })
                );
              }
            } catch (apiError) {
              console.error("Error applying changes:", apiError);
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: apiError.message }));
            }
          } catch (parseError) {
            console.error("Error parsing request data:", parseError);
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Invalid JSON" }));
          }
        });
      } else {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain");
        res.end("Not found");
      }
    });

    // Handle errors to prevent crashes
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.log(
          `\x1b[33mℹ Codepress Dev Server: Port ${port} is already in use, server is likely already running\x1b[0m`
        );
      } else {
        console.error("Codepress Dev Server error:", err);
      }
    });
  } catch (err) {
    console.error("Failed to create server:", err);
    return null;
  }

  // Start server on the fixed port
  server.listen(port, () => {
    console.log(
      `\x1b[32m✅ Codepress Dev Server running at http://localhost:${port}\x1b[0m`
    );
  });

  // Save instance
  serverInstance = server;

  return server;
}

// Create module exports
const serverModule = {
  startServer,
};

// Start server automatically if in development mode
if (process.env.NODE_ENV !== "production") {
  serverModule.server = startServer();
}

// Export module
module.exports = serverModule;
