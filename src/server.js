/**
 * @fileoverview Codepress Development Server (Refactored)
 * Provides API endpoints for visual editing and file modification
 */

const fastify = require("fastify");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { decode } = require("./utils/encoding");
const { createLogger } = require("./utils/logger");
const {
  toAbsolutePath,
  readFileFromEncodedLocation,
  applyFullFileReplacement,
  saveImageData,
} = require("./services/fileService");
const {
  applyTextChanges,
  applyPatternChanges,
  applyChangesAndFormat,
} = require("./services/textChangeService");
const {
  callBackendApi,
  getChanges,
  getAgentChanges,
} = require("./services/backendService");
const {
  validateRequestData,
  hasValidContent,
  isValidEncodedLocation,
} = require("./services/validationService");

// Create logger instance for server
const logger = createLogger("server");

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
            logger.warn(
              `Invalid regex pattern for "${pattern}"`,
              { error: error.message }
            );
            return null;
          }
        })
        .filter((regex) => regex !== null); // Remove null entries

      // Combine default patterns with gitignore patterns
      excludePatterns = [...excludePatterns, ...gitignorePatterns];

      logger.info(
        `Found ${gitignorePatterns.length} valid gitignore patterns`
      );
    } else {
      logger.warn("No .gitignore file found, no exclusions applied");
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
        logger.warn(`Error reading directory ${dir}`, { error: error.message });
      }

      return files;
    }

    const fileList = getFilesRecursively(process.cwd());
    logger.info(`Generated file list with ${fileList.length} files`);

    // Return as a formatted string with one file per line
    return fileList.sort().join("\n");
  } catch (error) {
    logger.error("Error generating project structure", { error: error.message });
    return "Unable to generate project structure";
  }
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
      logger.error("Error getting project structure", { error: error.message });
      return reply.code(500).send({
        success: false,
        error: "Failed to get project structure",
        message: error.message,
      });
    }
  });

  // Visual editor API route for regular agent changes
  app.post("/visual-editor-api", async (request, reply) => {
    const startTime = Date.now();
    try {
      const { changes, github_repo_name } = request.body;
      const authHeader =
        request.headers.authorization || request.headers["authorization"];

      logger.debug("Auth header received", { 
        hasAuth: !!authHeader,
        changesCount: Array.isArray(changes) ? changes.length : 0,
        repo: github_repo_name
      });

      if (!Array.isArray(changes)) {
        return reply.code(400).send({
          error: "Invalid request format: 'changes' must be an array.",
        });
      }

      logger.info("Visual Editor API Request", {
        changesCount: changes.length,
        repo: github_repo_name
      });

      // Debug: Check if browser dimensions are provided
      const changesWithDimensions = changes.filter(
        (change) => change.browser_width && change.browser_height
      );
      if (changesWithDimensions.length > 0) {
        const sampleChange = changesWithDimensions[0];
        logger.debug("Browser dimensions detected", {
          width: sampleChange.browser_width,
          height: sampleChange.browser_height
        });
      } else {
        logger.warn("No browser dimensions found in changes");
      }

      // Optimize file reading by pre-fetching unique file contents
      const uniqueEncodedLocations = new Set();
      const validChanges = [];

      // First pass: collect unique encoded locations and validate changes
      for (const change of changes) {
        logger.debug("Processing change", { change: JSON.stringify(change) });

        try {
          if (!isValidEncodedLocation(change.encoded_location)) {
            logger.warn("Skipping change with missing encoded_location");
            continue;
          }

          const encodedFilePath = change.encoded_location.split(":")[0];
          const targetFile = decode(encodedFilePath);
          if (!targetFile) {
            logger.warn("Skipping change with undecodable file", {
              encodedLocation: change.encoded_location
            });
            continue;
          }

          // Check if this change has actual content
          if (!hasValidContent(change)) {
            logger.warn("Skipping change with no style or text changes");
            continue;
          }

          // Collect unique encoded locations for batch reading
          uniqueEncodedLocations.add(change.encoded_location);
          validChanges.push(change);
        } catch (e) {
          logger.error("Error processing change", {
            encodedLocation: change.encoded_location,
            error: e.message
          });
        }
      }

      // Pre-fetch all unique file contents once
      const fileContentMap = new Map();
      for (const encodedLocation of uniqueEncodedLocations) {
        try {
          const { fileContent } = readFileFromEncodedLocation(encodedLocation);
          fileContentMap.set(encodedLocation, fileContent);
        } catch (e) {
          logger.error("Error reading file for location", {
            encodedLocation,
            error: e.message
          });
        }
      }

      logger.info("Pre-fetched files", {
        uniqueFiles: fileContentMap.size,
        validChanges: validChanges.length
      });

      // Second pass: process each change with pre-fetched content
      const fileChangesForBackend = [];
      for (const change of validChanges) {
        try {
          // Get pre-fetched file content from map
          const fileContent = fileContentMap.get(change.encoded_location);
          if (!fileContent) {
            logger.warn("Skipping change with missing file content", {
              encodedLocation: change.encoded_location
            });
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
          logger.error("Error processing change", {
            encodedLocation: change.encoded_location,
            error: e.message
          });
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

      logger.info("Sending request to backend", {
        fileChanges: fileChangesForBackend.length,
        originalChanges: changes.length
      });

      // Debug: Log browser dimensions being sent to backend
      const backendChangesWithDimensions = fileChangesForBackend.filter(
        (change) => change.browser_width && change.browser_height
      );
      if (backendChangesWithDimensions.length > 0) {
        logger.debug("Sending browser dimensions to backend", {
          changesWithDimensions: backendChangesWithDimensions.length
        });
      }

      const backendResponse = await getChanges({
        githubRepoName: github_repo_name,
        fileChanges: fileChangesForBackend,
        authHeader,
      });

      const updatedFiles = new Set();
      if (backendResponse && backendResponse.updated_files) {
        logger.info("Processing updated_files format");
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

      const duration = Date.now() - startTime;
      logger.success("Changes applied successfully", {
        updatedFiles: updatedFiles.size,
        individualChanges: changes.length,
        duration: `${duration}ms`
      });

      return reply.code(200).send({
        message: `Changes applied successfully to ${
          updatedFiles.size
        } file(s). Processed ${changes.length} individual changes with preserved line number information.`,
        updatedFiles: Array.from(updatedFiles),
      });
    } catch (err) {
      const duration = Date.now() - startTime;
      logger.error("Fatal error in /visual-editor-api", {
        error: err.message,
        duration: `${duration}ms`
      });
      return reply.code(500).send({
        error: "An internal server error occurred",
        details: err.message,
      });
    }
  });

  // Visual editor API route for agent changes
  app.post("/visual-editor-api-agent", async (request, reply) => {
    const startTime = Date.now();
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

      logger.debug("Agent API request", {
        hasAuth: !!authHeader,
        encodedLocation: encoded_location,
        repo: github_repo_name
      });

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

        const duration = Date.now() - startTime;
        logger.success("Agent changes applied", {
          filesModified: results.length,
          duration: `${duration}ms`
        });

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

        const duration = Date.now() - startTime;
        logger.success("Agent changes applied (legacy)", { duration: `${duration}ms` });

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

        const duration = Date.now() - startTime;
        logger.success("Agent changes applied (coding_agent_output)", { duration: `${duration}ms` });

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

        const duration = Date.now() - startTime;
        logger.success("Agent changes applied (changes array)", { duration: `${duration}ms` });

        return reply.code(200).send({
          success: true,
          message: "Agent changes applied successfully.",
          modified_content: formattedCode,
        });
      }

      throw new Error("Invalid response format from backend");
    } catch (err) {
      const duration = Date.now() - startTime;
      logger.error("Error in /visual-editor-api-agent", {
        error: err.message,
        duration: `${duration}ms`
      });
      return reply.code(500).send({ error: err.message });
    }
  });

  return app;
}

/**
 * Starts the Codepress development server if not already running
 * @param {Object} options - Server configuration options
 * @param {number} [options.port=4321] - Port to run the server on
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
    logger.info("Server already running on another process");
    return null;
  }

  // Get the fixed port
  const port = options.port || getServerPort();

  try {
    // Create the Fastify app
    const app = createApp();

    // Start the server
    await app.listen({ port, host: "0.0.0.0" });

    logger.success(`Codepress Dev Server running`, {
      url: `http://localhost:${port}`,
      port,
      environment: process.env.NODE_ENV || "development"
    });

    // Save instance
    serverInstance = app;

    return app;
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      logger.warn(`Port ${port} is already in use, server is likely already running`);
    } else {
      logger.error("Codepress Dev Server error", { error: err.message });
    }
    return null;
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
      logger.error("Failed to auto-start server", { error: err.message });
    }
  })();
}

// Export module
module.exports = serverModule;