/**
 * @fileoverview Codepress Development Server
 * Provides API endpoints for visual editing and file modification
 */

const fastify = require("fastify");
const os = require("os");
const fs = require("fs");
const path = require("path");
const prettier = require("prettier");
const fetch = require("node-fetch");
const { decode } = require("./utils/encoding");

/**
 * Normalizes a possibly-relative or malformed absolute path into an absolute path.
 * - Uses CWD for relative paths
 * - Fixes common case where macOS absolute paths lose their leading slash (e.g., "Users/...")
 * @param {string} inputPath - The input file path to normalize
 * @returns {string} The normalized absolute path
 */
function toAbsolutePath(inputPath) {
  if (!inputPath) {
    return inputPath;
  }
  const trimmedPath = String(inputPath).trim();

  // Fix macOS-like absolute paths missing the leading slash, e.g. "Users/..."
  const looksLikePosixAbsNoSlash =
    process.platform !== "win32" &&
    (trimmedPath.startsWith("Users" + path.sep) ||
      trimmedPath.startsWith("Volumes" + path.sep));

  const candidate = looksLikePosixAbsNoSlash
    ? path.sep + trimmedPath
    : trimmedPath;

  return path.isAbsolute(candidate)
    ? candidate
    : path.join(process.cwd(), candidate);
}

/**
 * Gets the port to use for the server from environment variables
 * @returns {number} The configured port (default: 4321)
 */
function getServerPort() {
  // Use environment variable or default to 4321
  return parseInt(process.env.CODEPRESS_DEV_PORT || "4321", 10);
}

/**
 * Create a lock file to ensure only one server instance runs system-wide
 * Uses process PID to detect stale locks from crashed processes
 * @returns {boolean} True if lock was acquired, false if another instance is running
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
 * Apply text-based changes to file content using line-based operations
 * Changes are processed in reverse order to prevent line number shifts
 * @param {string} fileContent - The original file content
 * @param {Array<Object>} changes - Array of change objects to apply
 * @param {('insert'|'delete'|'replace')} changes[].type - Type of change operation
 * @param {number} [changes[].line] - Target line for insert operations (1-indexed)
 * @param {number} [changes[].startLine] - Start line for delete/replace operations (1-indexed)
 * @param {number} [changes[].endLine] - End line for delete/replace operations (1-indexed)
 * @param {string} [changes[].codeChange] - New code content for insert/replace operations
 * @returns {string} The modified file content with changes applied
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
 * Apply pattern-based changes to the file content based on the new format.
 * @param {string} fileContent The original file content
 * @param {Array<Object>} changes The changes to apply in the new format.
 *        Each change object can have:
 *        - { type: "replace", find: string, replaceWith: string, explanation: string }
 *        - { type: "insertAfter", find: string, insert: string, explanation: string }
 *        - { type: "insertBefore", find: string, insert: string, explanation: string }
 *        - { type: "delete", find: string, explanation: string }
 * @returns {string} The modified file content
 */
function applyPatternChanges(fileContent, changes) {
  let modifiedContent = fileContent;

  // Detect potential conflicts by checking for duplicate find patterns
  const findPatterns = new Map();
  changes.forEach((change, index) => {
    if (change.find) {
      if (findPatterns.has(change.find)) {
        const existingIndex = findPatterns.get(change.find);
        console.warn(
          "\x1b[33m⚠ CONFLICT DETECTED: Multiple changes target the same pattern\x1b[0m"
        );
        console.warn(
          `  Change ${existingIndex + 1}: ${changes[existingIndex].explanation}`
        );
        console.warn(`  Change ${index + 1}: ${change.explanation}`);
        console.warn(`  Pattern: ${change.find.substring(0, 100)}...`);
        console.warn(
          "\x1b[33m  → Only the first change will be applied\x1b[0m"
        );
      } else {
        findPatterns.set(change.find, index);
      }
    }
  });

  for (const change of changes) {
    const { type, find, replaceWith, insert, explanation } = change;

    console.log(`\x1b[36mℹ Applying ${type} change: ${explanation}\x1b[0m`);

    switch (type) {
    case "replace":
      if (find && replaceWith !== undefined) {
        if (modifiedContent.includes(find)) {
          // Check if replaceWith contains malformed JSX
          const openTags = (replaceWith.match(/<[^\/][^>]*>/g) || []).length;
          const closeTags = (replaceWith.match(/<\/[^>]*>/g) || []).length;

          if (openTags !== closeTags) {
            console.warn(
              "\x1b[33m⚠ POTENTIAL JSX MALFORMATION: Unmatched tags in replacement\x1b[0m"
            );
            console.warn(
              `  Open tags: ${openTags}, Close tags: ${closeTags}`
            );
            console.warn(
              `  Replacement: ${replaceWith.substring(0, 200)}...`
            );
          }

          modifiedContent = modifiedContent.replace(find, replaceWith);
          console.log("\x1b[32m✓ Replaced pattern successfully\x1b[0m");
        } else {
          console.warn(
            `\x1b[33m⚠ Pattern not found for replace: ${find.substring(0, 50)}...\x1b[0m`
          );
          console.warn(
            "\x1b[33m  This might be due to a previous change modifying the content\x1b[0m"
          );
        }
      } else {
        console.warn("Invalid 'replace' change object:", change);
      }
      break;

    case "insertAfter":
      if (find && insert !== undefined) {
        if (modifiedContent.includes(find)) {
          modifiedContent = modifiedContent.replace(find, find + insert);
          console.log(
            "\x1b[32m✓ Inserted content after pattern successfully\x1b[0m"
          );
        } else {
          console.warn(
            `\x1b[33m⚠ Pattern not found for insertAfter: ${find.substring(0, 50)}...\x1b[0m`
          );
        }
      } else {
        console.warn("Invalid 'insertAfter' change object:", change);
      }
      break;

    case "insertBefore":
      if (find && insert !== undefined) {
        if (modifiedContent.includes(find)) {
          modifiedContent = modifiedContent.replace(find, insert + find);
          console.log(
            "\x1b[32m✓ Inserted content before pattern successfully\x1b[0m"
          );
        } else {
          console.warn(
            `\x1b[33m⚠ Pattern not found for insertBefore: ${find.substring(0, 50)}...\x1b[0m`
          );
        }
      } else {
        console.warn("Invalid 'insertBefore' change object:", change);
      }
      break;

    case "delete":
      if (find) {
        if (modifiedContent.includes(find)) {
          modifiedContent = modifiedContent.replace(find, "");
          console.log("\x1b[32m✓ Deleted pattern successfully\x1b[0m");
        } else {
          console.warn(
            `\x1b[33m⚠ Pattern not found for delete: ${find.substring(0, 50)}...\x1b[0m`
          );
        }
      } else {
        console.warn("Invalid 'delete' change object:", change);
      }
      break;

    default:
      console.warn(`Unknown change type: ${type}`);
    }
  }

  return modifiedContent;
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
  const apiPort = parseInt(process.env.CODEPRESS_BACKEND_PORT || "8007", 10);
  const apiPath = endpoint.startsWith("/")
    ? endpoint.replace("/", "")
    : endpoint;

  // Build the complete URL - detect if using localhost for HTTP, otherwise use HTTPS
  const protocol =
    apiHost === "localhost" || apiHost === "127.0.0.1" ? "http" : "https";
  console.log(`\x1b[36mℹ API Path: ${apiPath} \x1b[0m`);
  const url = `${protocol}://${apiHost}${
    apiPort ? `:${apiPort}` : ""
  }/v1/${apiPath}`;
  console.log(`\x1b[36mℹ Sending request to ${url} \x1b[0m`);

  try {
    // First try to use API token from environment variable
    let authToken = process.env.CODEPRESS_API_TOKEN;

    // Debug: Log environment token status
    console.log(
      `\x1b[36mℹ Environment API token: ${authToken ? "[PRESENT]" : "[NOT SET]"}\x1b[0m`
    );
    console.log(
      `\x1b[36mℹ Incoming auth header: ${incomingAuthHeader ? "[PRESENT]" : "[NOT PROVIDED]"}\x1b[0m`
    );

    // If no API token, try to use the incoming Authorization header
    if (!authToken && incomingAuthHeader) {
      authToken = incomingAuthHeader.split(" ")[1]; // Extract token part
      console.log(
        "\x1b[36mℹ Using incoming Authorization header for authentication\x1b[0m"
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
      console.log(
        `\x1b[36mℹ Final auth header: Bearer ${authToken.substring(0, 10)}...\x1b[0m`
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

    // Debug: Log response status and preview
    console.log(`\x1b[36mℹ Response status: ${response.status}\x1b[0m`);
    console.log(
      `\x1b[36mℹ Response preview: ${responseText.substring(0, 100)}...\x1b[0m`
    );

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
    if (!old_html) {
      missingFields.push("old_html");
    }
    if (!new_html) {
      missingFields.push("new_html");
    }

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
  if (!imageData) {
    return null;
  }

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

      if (imageExtension === "jpeg") {
        imageExtension = "jpg";
      }
      if (imageExtension === "svg+xml") {
        imageExtension = "svg";
      }

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

  // If filePath is absolute, use it directly. Otherwise, join with cwd.
  const targetFile = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);

  console.log(`\x1b[36mℹ Reading file: ${targetFile}\x1b[0m`);
  const fileContent = fs.readFileSync(targetFile, "utf8");

  return { filePath, targetFile, fileContent };
}

/**
 * Service: Apply changes and format code
 * @param {string} fileContent Original file content
 * @param {Array} changes Array of changes to apply
 * @param {string} targetFile Target file path
 * @param {boolean} usePatternChanges Whether to use pattern-based changes (true) or text-based changes (false)
 * @returns {Promise<string>} Formatted code
 */
async function applyChangesAndFormat(
  fileContent,
  changes,
  targetFile,
  usePatternChanges = true
) {
  console.log(
    `\x1b[36mℹ Received ${changes.length} changes from backend\x1b[0m`
  );

  // Apply the changes using the appropriate function based on the flag
  const modifiedContent = usePatternChanges
    ? applyPatternChanges(fileContent, changes)
    : applyTextChanges(fileContent, changes);

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
    `\x1b[32m✓ Updated file ${targetFile} with ${changes.length} changes using ${usePatternChanges ? "pattern-based" : "text-based"} approach\x1b[0m`
  );

  return formattedCode;
}

/**
 * Service: Get changes from backend (original endpoint)
 * @param {Object} params Request parameters
 * @param {string} params.githubRepoName The GitHub repository name
 * @param {Array<Object>} params.fileChanges Array of file change objects to process. Each object represents changes for a single file.
 * @param {string} params.fileChanges[].encoded_location The encoded file location identifier used to determine which file to modify
 * @param {string} params.fileChanges[].file_content The current content of the file being modified
 * @param {Array<Object>} params.fileChanges[].style_changes Array of style-related changes to apply to the file. Each object contains styling modifications.
 * @param {Array<Object>} params.fileChanges[].text_changes Array of text-based changes to apply to the file. Each object contains:
 * @param {string} params.fileChanges[].text_changes[].old_text The original HTML/text content to be replaced (mapped from old_html)
 * @param {string} params.fileChanges[].text_changes[].new_text The new HTML/text content to replace with (mapped from new_html)
 * @param {string} [params.fileChanges[].text_changes[].encoded_location] The encoded location for this specific text change (inherited from parent change object)
 * @param {Array<Object>} [params.fileChanges[].text_changes[].style_changes] Any style changes associated with this text change (inherited from parent change object)
 * @param {string} [params.authHeader] The authorization header for backend API authentication (Bearer token)
 * @returns {Promise<Object>} Backend response containing the processed changes, typically with an 'updated_files' property mapping file paths to their new content
 */
async function getChanges({ githubRepoName, fileChanges, authHeader }) {
  console.log(
    `\x1b[36mℹ Getting changes from backend for ${fileChanges.length} files\x1b[0m`
  );

  return await callBackendApi(
    "POST",
    "code-sync/get-changes",
    {
      github_repo_name: githubRepoName,
      file_changes: fileChanges,
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
  githubRepoName,
  encodedLocation,
  fileContent,
  additionalContext,
  authHeader,
}) {
  console.log(
    `\x1b[36mℹ Getting agent changes from backend for file encoded_location: ${encodedLocation}\x1b[0m`
  );

  return await callBackendApi(
    "POST",
    "code-sync/get-agent-changes",
    {
      github_repo_name: githubRepoName,
      encoded_location: encodedLocation,
      file_content: fileContent,
      additional_context: additionalContext,
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
  console.log("\x1b[36mℹ Applying full file replacement\x1b[0m");

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
      const { changes, github_repo_name } = request.body;
      const authHeader =
        request.headers.authorization || request.headers["authorization"];

      // Debug: Log auth header info
      console.log(
        `\x1b[36mℹ Auth header received: ${authHeader ? "[PRESENT]" : "[MISSING]"}\x1b[0m`
      );

      if (!Array.isArray(changes)) {
        return reply.code(400).send({
          error: "Invalid request format: 'changes' must be an array.",
        });
      }

      console.log(
        `\x1b[36mℹ Visual Editor API Request: Received ${changes.length} changes for repo ${github_repo_name}\x1b[0m`
      );

      // Debug: Check if browser dimensions are provided
      const changesWithDimensions = changes.filter(
        (change) => change.browser_width && change.browser_height
      );
      if (changesWithDimensions.length > 0) {
        const sampleChange = changesWithDimensions[0];
        console.log(
          `\x1b[36mℹ Browser dimensions detected: ${sampleChange.browser_width}x${sampleChange.browser_height}\x1b[0m`
        );
      } else {
        console.log("\x1b[33m⚠ No browser dimensions found in changes\x1b[0m");
      }

      // Optimize file reading by pre-fetching unique file contents
      const uniqueEncodedLocations = new Set();
      const validChanges = [];

      // First pass: collect unique encoded locations and validate changes
      for (const change of changes) {
        console.log(`\x1b[36mℹ change: ${JSON.stringify(change)}\x1b[0m`);

        try {
          if (!change.encoded_location) {
            console.warn(
              "\x1b[33m⚠ Skipping change with missing encoded_location.\x1b[0m"
            );
            continue;
          }

          const encodedFilePath = change.encoded_location.split(":")[0];
          const targetFile = decode(encodedFilePath);
          if (!targetFile) {
            console.warn(
              `\x1b[33m⚠ Skipping change with undecodable file from encoded_location: ${change.encoded_location}.\x1b[0m`
            );
            continue;
          }

          // Check if this change has actual content
          const hasStyleChanges =
            change.style_changes && change.style_changes.length > 0;
          const hasTextChanges =
            change.text_changes && change.text_changes.length > 0;

          if (!hasStyleChanges && !hasTextChanges) {
            console.warn(
              "\x1b[33m⚠ Skipping change with no style or text changes.\x1b[0m"
            );
            continue;
          }

          // Collect unique encoded locations for batch reading
          uniqueEncodedLocations.add(change.encoded_location);
          validChanges.push(change);
        } catch (e) {
          console.error(
            `\x1b[31m✖ Error processing change for location: ${change.encoded_location}\x1b[0m`
          );
        }
      }

      // Pre-fetch all unique file contents once
      const fileContentMap = new Map();
      for (const encodedLocation of uniqueEncodedLocations) {
        try {
          const { fileContent } = readFileFromEncodedLocation(encodedLocation);
          fileContentMap.set(encodedLocation, fileContent);
        } catch (e) {
          console.error(
            `\x1b[31m✖ Error reading file for location: ${encodedLocation}\x1b[0m`
          );
        }
      }

      console.log(
        `\x1b[36mℹ Pre-fetched ${fileContentMap.size} unique files for ${validChanges.length} changes\x1b[0m`
      );

      // Second pass: process each change with pre-fetched content
      const fileChangesForBackend = [];
      for (const change of validChanges) {
        try {
          // Get pre-fetched file content from map
          const fileContent = fileContentMap.get(change.encoded_location);
          if (!fileContent) {
            console.warn(
              `\x1b[33m⚠ Skipping change with missing file content for: ${change.encoded_location}\x1b[0m`
            );
            continue;
          }

          // Create individual change entry with its specific encoded_location
          fileChangesForBackend.push({
            encoded_location: change.encoded_location, // Preserve individual encoded_location
            file_content: fileContent,
            changes: [
              {
                style_changes: change.style_changes || [],
                text_changes: change.text_changes || [],
              },
            ],
            browser_width: change.browser_width,
            browser_height: change.browser_height,
          });
        } catch (e) {
          console.error(
            `\x1b[31m✖ Error processing change for location: ${change.encoded_location}\x1b[0m`
          );
        }
      }

      // Process image uploads first across all files
      for (const change of changes) {
        if (change.image_data && change.filename) {
          await saveImageData(change.image_data, change.filename);
        }
      }

      if (fileChangesForBackend.length === 0) {
        return reply.code(200).send({
          message: "No changes to apply.",
          updatedFiles: [],
        });
      }

      console.log(
        `\x1b[36mℹ Sending request for ${fileChangesForBackend.length} individual changes (${changes.length} total original changes)\x1b[0m`
      );

      // Debug: Log browser dimensions being sent to backend
      const backendChangesWithDimensions = fileChangesForBackend.filter(
        (change) => change.browser_width && change.browser_height
      );
      if (backendChangesWithDimensions.length > 0) {
        console.log(
          `\x1b[36mℹ Sending browser dimensions to backend for ${backendChangesWithDimensions.length} changes\x1b[0m`
        );
      }

      const backendResponse = await getChanges({
        githubRepoName: github_repo_name,
        fileChanges: fileChangesForBackend,
        authHeader,
      });

      const updatedFiles = new Set();
      if (backendResponse && backendResponse.updated_files) {
        console.log("\x1b[36mℹ Processing updated_files format\x1b[0m");
        for (const [filePath, newContent] of Object.entries(
          backendResponse.updated_files
        )) {
          const targetFile = toAbsolutePath(filePath);

          await applyFullFileReplacement(newContent, targetFile);
          updatedFiles.add(targetFile);
        }
      }

      if (updatedFiles.size === 0) {
        return reply.code(200).send({
          message: "No changes were applied.",
          updatedFiles: [],
        });
      }

      return reply.code(200).send({
        message: `Changes applied successfully to ${
          updatedFiles.size
        } file(s). Processed ${changes.length} individual changes with preserved line number information.`,
        updatedFiles: Array.from(updatedFiles),
      });
    } catch (err) {
      console.error(
        `\x1b[31m✖ Fatal error in /visual-editor-api: ${err.message}\x1b[0m`
      );
      return reply.code(500).send({
        error: "An internal server error occurred",
        details: err.message,
      });
    }
  });

  // Visual editor API route for agent changes
  app.post("/visual-editor-api-agent", async (request, reply) => {
    try {
      const data = request.body;
      const {
        encoded_location,
        github_repo_name,
        image_data,
        filename,
        style_changes,
        text_changes,
        additional_context,
        additionalContext,
      } = data;
      const authHeader =
        request.headers.authorization || request.headers["authorization"];

      // Debug: Log auth header info
      console.log(
        `\x1b[36mℹ [visual-editor-api-agent] Auth header received: ${authHeader ? "[PRESENT]" : "[MISSING]"}\x1b[0m`
      );

      const { targetFile, fileContent } =
        readFileFromEncodedLocation(encoded_location);

      await saveImageData(image_data, filename);

      const backendResponse = await getAgentChanges({
        githubRepoName: github_repo_name,
        encodedLocation: encoded_location,
        styleChanges: style_changes,
        textChanges: text_changes,
        fileContent,
        additionalContext: additional_context || additionalContext,
        authHeader,
      });
      // New shape: updated_files dict of path -> content. Replace all files present
      if (backendResponse && backendResponse.updated_files) {
        const results = [];
        for (const [filePath, newContent] of Object.entries(
          backendResponse.updated_files
        )) {
          const targetFilePath = toAbsolutePath(filePath);
          const formattedCode = await applyFullFileReplacement(
            newContent,
            targetFilePath
          );
          results.push({ path: filePath, modified_content: formattedCode });
        }
        return reply.code(200).send({
          success: true,
          message: `Agent changes applied to ${results.length} file(s).`,
          files: results,
        });
      }

      // Legacy fallback: maintain previous handling
      if (backendResponse && backendResponse.modified_content !== null) {
        const modifiedContentStr = String(backendResponse.modified_content);
        const formattedCode = await applyFullFileReplacement(
          modifiedContentStr,
          targetFile
        );
        return reply.code(200).send({
          success: true,
          message: "Agent changes applied successfully.",
          modified_content: formattedCode,
        });
      }

      if (
        backendResponse &&
        backendResponse.coding_agent_output &&
        Array.isArray(backendResponse.coding_agent_output)
      ) {
        const fileData =
          backendResponse.coding_agent_output.find(
            (f) =>
              f.path &&
              (f.path === targetFile ||
                f.path.endsWith(path.basename(targetFile)))
          ) || backendResponse.coding_agent_output[0];

        const currentContent = fs.readFileSync(targetFile, "utf8");
        const formattedCode = await applyChangesAndFormat(
          currentContent,
          fileData.changes,
          targetFile,
          false
        );
        return reply.code(200).send({
          success: true,
          message: "Agent changes applied successfully.",
          modified_content: formattedCode,
        });
      }

      if (backendResponse && Array.isArray(backendResponse.changes)) {
        const formattedCode = await applyChangesAndFormat(
          fileContent,
          backendResponse.changes,
          targetFile,
          false
        );
        return reply.code(200).send({
          success: true,
          message: "Agent changes applied successfully.",
          modified_content: formattedCode,
        });
      }

      throw new Error("Invalid response format from backend");
    } catch (err) {
      console.error(`Error in /visual-editor-api-agent: ${err.message}`);
      return reply.code(500).send({ error: err.message });
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
    let excludePatterns = [
      /^\.git(\/.*)?$/, // Exclude .git directory by default
    ];

    if (fs.existsSync(gitignorePath)) {
      const gitignoreContent = fs.readFileSync(gitignorePath, "utf8");
      const gitignorePatterns = gitignoreContent
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

      // Combine default patterns with gitignore patterns
      excludePatterns = [...excludePatterns, ...gitignorePatterns];

      console.log(
        `\x1b[36mℹ Found ${gitignorePatterns.length} valid gitignore patterns\x1b[0m`
      );
    } else {
      console.log(
        "\x1b[33m⚠ No .gitignore file found, no exclusions applied\x1b[0m"
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
