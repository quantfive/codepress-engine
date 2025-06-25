// Codepress Dev Server
const fastify = require("fastify");
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
  const url = `${protocol}://${apiHost}${
    apiPort ? `:${apiPort}` : ""
  }/api/${apiPath}`;
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
        `\x1b[36mℹ Using ${
          process.env.CODEPRESS_API_TOKEN ? "API Token" : "GitHub OAuth Token"
        } for authentication\x1b[0m`
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
 * Service: Validate request data based on mode
 * @param {Object} data The request data
 * @param {boolean} isAiMode Whether this is AI mode
 * @returns {Object} Validation result with error or success
 */
function validateRequestData(data, isAiMode) {
  const {
    encoded_location,
    old_html,
    new_html,
    aiInstruction,
    ai_instruction,
  } = data;

  const actualAiInstruction = ai_instruction || aiInstruction;

  if (!encoded_location) {
    return {
      isValid: false,
      error: "Missing encoded_location field",
      errorData: { encoded_location: encoded_location || undefined },
    };
  }

  if (isAiMode) {
    // AI mode validation
    if (!actualAiInstruction) {
      return {
        isValid: false,
        error: "Missing aiInstruction field in AI mode",
        errorData: { encoded_location, mode: "ai" },
      };
    }
  } else {
    // Regular mode validation
    const missingFields = [];
    if (!old_html) missingFields.push("old_html");
    if (!new_html) missingFields.push("new_html");

    if (missingFields.length > 0) {
      return {
        isValid: false,
        error: `Missing required fields: ${missingFields.join(", ")}`,
        errorData: { encoded_location, missingFields },
      };
    }
  }

  return { isValid: true };
}

/**
 * Service: Save image data to file system
 * @param {string} imageData Base64 image data
 * @param {string} filename Optional filename
 * @returns {Promise<string|null>} The saved image path or null if failed
 */
async function saveImageData(imageData, filename) {
  if (!imageData) return null;

  try {
    const imageDir = path.join(process.cwd(), "public");
    if (!fs.existsSync(imageDir)) {
      fs.mkdirSync(imageDir, { recursive: true });
      console.log(`\x1b[36mℹ Created directory: ${imageDir}\x1b[0m`);
    }

    let imagePath;
    let base64Data;

    if (filename) {
      imagePath = path.join(imageDir, filename);
      // When filename is provided, assume image_data is just the base64 string
      const match = imageData.match(/^data:image\/[\w+]+\;base64,(.+)$/);
      if (match && match[1]) {
        base64Data = match[1]; // Extract if full data URI is sent
      } else {
        base64Data = imageData; // Assume raw base64
      }
      console.log(`\x1b[36mℹ Using provided filename: ${filename}\x1b[0m`);
    } else {
      // Fallback to existing logic if filename is not provided
      const match = imageData.match(/^data:image\/([\w+]+);base64,(.+)$/);
      let imageExtension;

      if (match && match[1] && match[2]) {
        imageExtension = match[1];
        base64Data = match[2];
      } else {
        base64Data = imageData;
        imageExtension = "png";
        console.log(
          "\x1b[33m⚠ Image data URI prefix not found and no filename provided, defaulting to .png extension.\x1b[0m"
        );
      }

      if (imageExtension === "jpeg") imageExtension = "jpg";
      if (imageExtension === "svg+xml") imageExtension = "svg";

      const imageName = `image_${Date.now()}.${imageExtension}`;
      imagePath = path.join(imageDir, imageName);
    }

    const imageBuffer = Buffer.from(base64Data, "base64");
    fs.writeFileSync(imagePath, imageBuffer);
    console.log(`\x1b[32m✓ Image saved to ${imagePath}\x1b[0m`);
    return imagePath;
  } catch (imgError) {
    console.error(`\x1b[31m✗ Error saving image: ${imgError.message}\x1b[0m`);
    return null;
  }
}

/**
 * Service: Read file content from encoded location
 * @param {string} encodedLocation The encoded file location
 * @returns {Object} File data with path and content
 */
function readFileFromEncodedLocation(encodedLocation) {
  const encodedFilePath = encodedLocation.split(":")[0];
  const filePath = decode(encodedFilePath);
  console.log(`\x1b[36mℹ Decoded file path: ${filePath}\x1b[0m`);
  const targetFile = path.join(process.cwd(), filePath);
  console.log(`\x1b[36mℹ Reading file: ${targetFile}\x1b[0m`);
  const fileContent = fs.readFileSync(targetFile, "utf8");

  return { filePath, targetFile, fileContent };
}

/**
 * Service: Apply changes and format code
 * @param {string} fileContent Original file content
 * @param {Array} changes Array of changes to apply
 * @param {string} targetFile Target file path
 * @returns {Promise<string>} Formatted code
 */
async function applyChangesAndFormat(fileContent, changes, targetFile) {
  console.log(
    `\x1b[36mℹ Received ${changes.length} changes from backend\x1b[0m`
  );

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

  return formattedCode;
}

/**
 * Service: Get AI changes from backend
 * @param {Object} params Request parameters
 * @returns {Promise<Object>} Backend response
 */
async function getAiChanges({
  encodedLocation,
  aiInstruction,
  fileContent,
  githubRepoName,
  githubMode,
  authHeader,
}) {
  console.log(
    `\x1b[36mℹ Getting AI changes from backend for file encoded_location: ${encodedLocation}\x1b[0m`
  );
  console.log(`\x1b[36mℹ AI Instruction: ${aiInstruction}\x1b[0m`);

  // Get project structure
  const projectStructure = getProjectStructure();
  console.log(`\x1b[36mℹ Including project structure in AI request\x1b[0m`);

  return await callBackendApi(
    "POST",
    "code-sync/get-ai-changes",
    {
      encoded_location: encodedLocation,
      ai_instruction: aiInstruction,
      file_content: fileContent,
      github_repo_name: githubRepoName,
      github_mode: githubMode,
      project_structure: projectStructure,
    },
    authHeader
  );
}

/**
 * Service: Get changes from backend (original endpoint)
 * @param {Object} params Request parameters
 * @returns {Promise<Object>} Backend response
 */
async function getChanges({
  oldHtml,
  newHtml,
  githubRepoName,
  encodedLocation,
  styleChanges,
  textChanges,
  fileContent,
  authHeader,
}) {
  console.log(
    `\x1b[36mℹ Getting changes from backend for file encoded_location: ${encodedLocation}\x1b[0m`
  );

  return await callBackendApi(
    "POST",
    "code-sync/get-changes",
    {
      old_html: oldHtml,
      new_html: newHtml,
      github_repo_name: githubRepoName,
      encoded_location: encodedLocation,
      style_changes: styleChanges,
      text_changes: textChanges,
      file_content: fileContent,
    },
    authHeader
  );
}

/**
 * Service: Get agent changes from backend
 * @param {Object} params Request parameters
 * @returns {Promise<Object>} Backend response
 */
async function getAgentChanges({
  oldHtml,
  newHtml,
  githubRepoName,
  encodedLocation,
  styleChanges,
  textChanges,
  fileContent,
  authHeader,
}) {
  console.log(
    `\x1b[36mℹ Getting agent changes from backend for file encoded_location: ${encodedLocation}\x1b[0m`
  );

  return await callBackendApi(
    "POST",
    "code-sync/get-agent-changes",
    {
      old_html: oldHtml,
      new_html: newHtml,
      github_repo_name: githubRepoName,
      encoded_location: encodedLocation,
      style_changes: styleChanges,
      text_changes: textChanges,
      file_content: fileContent,
    },
    authHeader
  );
}

/**
 * Service: Apply full file replacement and format code
 * @param {string} modifiedContent The complete new file content
 * @param {string} targetFile Target file path
 * @returns {Promise<string>} Formatted code
 */
async function applyFullFileReplacement(modifiedContent, targetFile) {
  console.log(`\x1b[36mℹ Applying full file replacement\x1b[0m`);

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
    `\x1b[32m✓ Updated file ${targetFile} with complete file replacement\x1b[0m`
  );

  return formattedCode;
}

/**
 * Create and configure the Fastify app
 * @returns {Object} The configured Fastify instance
 */
function createApp() {
  const app = fastify({
    logger: false, // Disable built-in logging since we have custom logging
  });

  // Register CORS plugin
  app.register(require("@fastify/cors"), {
    origin: "*",
    methods: ["GET", "POST", "OPTIONS", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["X-Requested-With", "content-type", "Authorization"],
    credentials: true,
  });

  // Ping route
  app.get("/ping", async (request, reply) => {
    return reply.code(200).type("text/plain").send("pong");
  });

  // Meta route
  app.get("/meta", async (request, reply) => {
    // Try to get package version but don't fail if not available
    let version = "0.0.0";
    try {
      // In production builds, use a relative path that works with the installed package structure
      version = require("../package.json").version;
    } catch (e) {
      // Ignore error, use default version
    }

    return reply.code(200).send({
      name: "Codepress Dev Server",
      version: version,
      environment: process.env.NODE_ENV || "development",
      uptime: process.uptime(),
    });
  });

  // Project structure route
  app.get("/project-structure", async (request, reply) => {
    try {
      const structure = getProjectStructure();
      return reply.code(200).send({
        success: true,
        structure: structure,
      });
    } catch (error) {
      console.error("Error getting project structure:", error);
      return reply.code(500).send({
        success: false,
        error: "Failed to get project structure",
        message: error.message,
      });
    }
  });

  // Visual editor API route for regular agent changes
  app.post("/visual-editor-api", async (request, reply) => {
    try {
      const data = request.body;
      const {
        encoded_location,
        old_html,
        new_html,
        github_repo_name,
        image_data,
        filename,
        style_changes,
        text_changes,
        agent_mode,
      } = data;

      // Debug logging to see what's being received
      console.log(
        `\x1b[36mℹ Visual Editor API Request data: ${JSON.stringify({
          data,
        })}\x1b[0m`
      );

      // Validate request data for regular mode
      const validation = validateRequestData(data, false);
      if (!validation.isValid) {
        return reply.code(400).send({
          error: validation.error,
          ...validation.errorData,
        });
      }

      try {
        const authHeader = request.headers["authorization"];

        // Read file content
        const { filePath, targetFile, fileContent } =
          readFileFromEncodedLocation(encoded_location);

        // Save image if present
        await saveImageData(image_data, filename);

        const getChangeApi = agent_mode ? getAgentChanges : getChanges;

        // Get agent changes from backend
        const backendResponse = await getChangeApi({
          oldHtml: old_html,
          newHtml: new_html,
          githubRepoName: github_repo_name,
          encodedLocation: encoded_location,
          styleChanges: style_changes,
          textChanges: text_changes,
          fileContent,
          authHeader,
        });

        console.log(`\x1b[36mℹ Received response from backend\x1b[0m`);

        console.log("backendResponse", backendResponse);
        // Check if this is the new agent response format with modified_content
        if (backendResponse.modified_content) {
          // Handle full file replacement
          const formattedCode = await applyFullFileReplacement(
            backendResponse.modified_content,
            targetFile
          );

          return reply.code(200).send({
            success: true,
            message:
              backendResponse.message || `Applied agent changes to ${filePath}`,
            modified_content: formattedCode,
          });
        } else if (
          backendResponse.changes &&
          Array.isArray(backendResponse.changes)
        ) {
          // Handle incremental changes (fallback)
          const formattedCode = await applyChangesAndFormat(
            fileContent,
            backendResponse.changes,
            targetFile
          );

          return reply.code(200).send({
            success: true,
            message: `Applied ${backendResponse.changes.length} changes to ${filePath}`,
          });
        } else {
          console.error(
            `\x1b[31m✗ Invalid response format: ${JSON.stringify(
              backendResponse
            )}\x1b[0m`
          );
          throw new Error("Invalid response format from backend");
        }
      } catch (apiError) {
        console.error("Error applying changes:", apiError);
        return reply.code(500).send({ error: apiError.message });
      }
    } catch (parseError) {
      console.error("Error parsing request data:", parseError);
      return reply.code(400).send({ error: "Invalid JSON" });
    }
  });

  // Visual editor API route for AI changes
  app.post("/visual-editor-api-ai", async (request, reply) => {
    try {
      const data = request.body;
      const {
        encoded_location,
        github_repo_name,
        github_mode,
        image_data,
        filename,
        aiInstruction,
        ai_instruction,
      } = data;

      // Use ai_instruction if provided, otherwise use aiInstruction
      const actualAiInstruction = ai_instruction || aiInstruction;

      // Debug logging to see what's being received
      console.log(
        `\x1b[36mℹ Visual Editor AI API Request data: ${JSON.stringify({
          encoded_location,
          aiInstruction: actualAiInstruction ? "[present]" : undefined,
          image_data: image_data ? "[present]" : undefined,
        })}\x1b[0m`
      );

      // Validate request data for AI mode
      const validation = validateRequestData(data, true);
      if (!validation.isValid) {
        return reply.code(400).send({
          error: validation.error,
          ...validation.errorData,
        });
      }

      try {
        const authHeader = request.headers["authorization"];

        // Read file content
        const { filePath, targetFile, fileContent } =
          readFileFromEncodedLocation(encoded_location);

        // Save image if present
        await saveImageData(image_data, filename);

        // Get AI changes from backend
        const backendResponse = await getAiChanges({
          encodedLocation: encoded_location,
          aiInstruction: actualAiInstruction,
          fileContent,
          githubRepoName: github_repo_name,
          githubMode: github_mode,
          authHeader,
        });

        console.log(`\x1b[36mℹ Received response from backend\x1b[0m`);

        // Check if this is the new format with modified_content (full file replacement)
        if (backendResponse.modified_content) {
          // Handle full file replacement
          const formattedCode = await applyFullFileReplacement(
            backendResponse.modified_content,
            targetFile
          );

          return reply.code(200).send({
            success: true,
            message:
              backendResponse.message || `Applied AI changes to ${filePath}`,
            modified_content: formattedCode,
          });
        } else if (
          backendResponse.changes &&
          Array.isArray(backendResponse.changes)
        ) {
          // Handle incremental changes (fallback)
          const formattedCode = await applyChangesAndFormat(
            fileContent,
            backendResponse.changes,
            targetFile
          );

          return reply.code(200).send({
            success: true,
            message: `Applied ${backendResponse.changes.length} AI-suggested changes to ${filePath}`,
            modified_content: formattedCode,
          });
        } else {
          console.error(
            `\x1b[31m✗ Invalid response format: ${JSON.stringify(
              backendResponse
            )}\x1b[0m`
          );
          throw new Error("Invalid response format from backend");
        }
      } catch (apiError) {
        console.error("Error applying AI changes:", apiError);
        return reply.code(500).send({ error: apiError.message });
      }
    } catch (parseError) {
      console.error("Error parsing request data:", parseError);
      return reply.code(400).send({ error: "Invalid JSON" });
    }
  });

  return app;
}

/**
 * Starts the Codepress development server if not already running
 * @param {Object} options Server configuration options
 * @param {number} [options.port=4321] Port to run the server on
 * @returns {Object|null} The Fastify instance or null if already running
 */
async function startServer(options = {}) {
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

  try {
    // Create the Fastify app
    const app = createApp();

    // Start the server
    await app.listen({ port, host: "0.0.0.0" });

    console.log(
      `\x1b[32m✅ Codepress Dev Server running at http://localhost:${port}\x1b[0m`
    );

    // Save instance
    serverInstance = app;

    return app;
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      console.log(
        `\x1b[33mℹ Codepress Dev Server: Port ${port} is already in use, server is likely already running\x1b[0m`
      );
    } else {
      console.error("Codepress Dev Server error:", err);
    }
    return null;
  }
}

/**
 * Get a list of files in the current project, respecting gitignore patterns
 * @returns {string} List of file paths, one per line
 */
function getProjectStructure() {
  try {
    // Read .gitignore patterns
    const gitignorePath = path.join(process.cwd(), ".gitignore");
    let excludePatterns = [];

    if (fs.existsSync(gitignorePath)) {
      const gitignoreContent = fs.readFileSync(gitignorePath, "utf8");
      excludePatterns = gitignoreContent
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")) // Remove empty lines and comments
        .map((pattern) => {
          // Convert gitignore patterns to regex patterns
          let regexPattern = pattern;

          // Handle negation patterns (starting with !)
          if (pattern.startsWith("!")) {
            // Skip negation patterns for now as they're complex to implement
            return null;
          }

          // Remove leading slash if present (gitignore treats /pattern as root-relative)
          if (regexPattern.startsWith("/")) {
            regexPattern = regexPattern.substring(1);
          }

          // Remove trailing slash for directories
          if (regexPattern.endsWith("/")) {
            regexPattern = regexPattern.substring(0, regexPattern.length - 1);
          }

          // Escape special regex characters except * and ?
          regexPattern = regexPattern
            .replace(/\./g, "\\.") // Escape dots
            .replace(/\+/g, "\\+") // Escape plus
            .replace(/\^/g, "\\^") // Escape caret
            .replace(/\$/g, "\\$") // Escape dollar
            .replace(/\(/g, "\\(") // Escape parentheses
            .replace(/\)/g, "\\)")
            .replace(/\[/g, "\\[") // Escape brackets
            .replace(/\]/g, "\\]")
            .replace(/\{/g, "\\{") // Escape braces
            .replace(/\}/g, "\\}")
            .replace(/\|/g, "\\|"); // Escape pipe

          // Convert gitignore wildcards to regex
          regexPattern = regexPattern
            .replace(/\*\*/g, ".*") // ** matches any number of directories
            .replace(/\*/g, "[^/]*") // * matches anything except path separator
            .replace(/\?/g, "[^/]"); // ? matches single character except path separator

          // Create regex pattern for matching file paths
          if (!regexPattern.includes("/")) {
            // If no slash, match files/directories at any level
            regexPattern = `(^|/)${regexPattern}(/.*)?$`;
          } else {
            // If contains slash, match from start
            regexPattern = `^${regexPattern}(/.*)?$`;
          }

          try {
            return new RegExp(regexPattern);
          } catch (error) {
            console.warn(
              `\x1b[33m⚠ Invalid regex pattern for "${pattern}": ${error.message}\x1b[0m`
            );
            return null;
          }
        })
        .filter((regex) => regex !== null); // Remove null entries

      console.log(
        `\x1b[36mℹ Found ${excludePatterns.length} valid gitignore patterns\x1b[0m`
      );
    } else {
      console.log(
        `\x1b[33m⚠ No .gitignore file found, no exclusions applied\x1b[0m`
      );
    }

    // Function to check if a path should be excluded
    function shouldExclude(relativePath) {
      return excludePatterns.some((pattern) => pattern.test(relativePath));
    }

    // Function to recursively get all files
    function getFilesRecursively(dir, baseDir = dir) {
      const files = [];

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(baseDir, fullPath);

          // Skip if excluded by gitignore patterns
          if (shouldExclude(relativePath)) {
            continue;
          }

          if (entry.isDirectory()) {
            // Recursively get files from subdirectory
            files.push(...getFilesRecursively(fullPath, baseDir));
          } else if (entry.isFile()) {
            // Add file to list
            files.push(relativePath);
          }
        }
      } catch (error) {
        console.warn(
          `\x1b[33m⚠ Error reading directory ${dir}: ${error.message}\x1b[0m`
        );
      }

      return files;
    }

    const fileList = getFilesRecursively(process.cwd());
    console.log(
      `\x1b[36mℹ Generated file list with ${fileList.length} files\x1b[0m`
    );

    // Return as a formatted string with one file per line
    return fileList.sort().join("\n");
  } catch (error) {
    console.error(`Error generating project structure: ${error.message}`);
    return "Unable to generate project structure";
  }
}

// Create module exports
const serverModule = {
  startServer,
};

// Start server automatically if in development mode
if (process.env.NODE_ENV !== "production") {
  // Make the auto-start async
  (async () => {
    try {
      serverModule.server = await startServer();
    } catch (err) {
      console.error("Failed to auto-start server:", err);
    }
  })();
}

// Export module
module.exports = serverModule;
