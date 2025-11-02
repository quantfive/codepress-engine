// Codepress Dev Server

import cors from "@fastify/cors";
import fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as prettier from "prettier";

import { decode } from "./index";

interface PatternChangeOperation {
  type: "replace" | "insertAfter" | "insertBefore" | "delete";
  find?: string;
  replaceWith?: string;
  insert?: string;
  explanation?: string;
}

interface VisualEditorTextChange {
  type: string;
  line?: number;
  startLine?: number;
  endLine?: number;
  codeChange?: string;
  old_text?: string;
  new_text?: string;
  encoded_location?: string;
  style_changes?: unknown[];
}

interface VisualEditorChange {
  encoded_location: string;
  old_html?: string;
  new_html?: string;
  old_text?: string;
  new_text?: string;
  text_changes?: VisualEditorTextChange[];
  pattern_changes?: PatternChangeOperation[];
  use_pattern_changes?: boolean;
  style_changes?: unknown[];
  move_changes?: unknown[];
  browser_width?: number;
  browser_height?: number;
  image_data?: string;
  filename?: string;
  ai_instruction?: string;
  aiInstruction?: string;
  [key: string]: unknown;
}

interface BackendFileChange {
  encoded_location: string;
  file_content: string;
  style_changes?: unknown[];
  text_changes?: VisualEditorTextChange[];
  pattern_changes?: PatternChangeOperation[];
  changes?: Array<{
    style_changes?: unknown[];
    text_changes?: VisualEditorTextChange[];
    move_changes?: unknown[];
  }>;
  browser_width?: number;
  browser_height?: number;
}

interface StreamingEvent {
  type: string;
  file_path?: string;
  content?: string;
  message?: string;
  success?: boolean;
  ephemeral?: boolean;
  filename?: string;
  result?: {
    updated_files?: Record<string, string>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface StartServerOptions {
  port?: number;
}

type FullFileReplacement = string | { type: "binary"; base64: string };

interface StreamingAgentRequestArgs {
  reply: FastifyReply;
  data: VisualEditorChange;
  authHeader?: string;
  fileContent: string;
}

interface VisualEditorApiBody {
  changes: VisualEditorChange[];
  github_repo_name?: string;
}

interface VisualEditorAgentBody extends VisualEditorChange {
  github_repo_name?: string;
}

interface WriteFilesBody {
  updated_files?: Record<string, string>;
}

// Backend response types
interface GetChangesResponsePayload {
  updated_files: Record<string, string>;
  success?: boolean;
  message?: string;
}

interface GetAgentChangesStreamingFinal {
  updated_files: Record<string, string>;
}

/**
 * Normalizes a possibly-relative or malformed absolute path into an absolute path.
 * - Uses CWD for relative paths
 * - Fixes common case where macOS absolute paths lose their leading slash (e.g., "Users/...")
 * @param {string} inputPath
 * @returns {string}
 */
function toAbsolutePath(inputPath: string | null | undefined): string {
  if (!inputPath) return process.cwd();
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
 * Gets the port to use for the server
 * @returns {number} The configured port
 */
function getServerPort(): number {
  // Use environment variable or default to 4321
  return parseInt(process.env.CODEPRESS_DEV_PORT || "4321", 10);
}

function getLockPath(port?: number): string {
  const suffix = port ? `-${port}` : "";
  return path.join(os.tmpdir(), `codepress-dev-server${suffix}.lock`);
}

function readLockFile(
  lockPath: string
): { pid?: number; timestamp?: number } | null {
  try {
    if (!fs.existsSync(lockPath)) return null;
    const raw = fs.readFileSync(lockPath, "utf8");
    return JSON.parse(raw) as { pid?: number; timestamp?: number };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // On Unix-like systems, sending signal 0 checks if the process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeLockFile(lockPath: string, pid: number): void {
  fs.writeFileSync(lockPath, JSON.stringify({ pid, timestamp: Date.now() }));
}

function removeLockFile(lockPath: string): void {
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // ignore
  }
}

/**
 * Create a lock file to ensure only one instance runs.
 * Cleans up stale locks automatically.
 * @returns {boolean} True if lock was acquired, false otherwise
 */
function acquireLock(): boolean {
  const lockPath = getLockPath(getServerPort());
  const existing = readLockFile(lockPath);
  if (existing?.pid && isPidAlive(existing.pid)) {
    return false;
  }
  removeLockFile(lockPath);
  try {
    writeLockFile(lockPath, process.pid);
    return true;
  } catch (err) {
    console.error("Error acquiring lock:", err);
    return false;
  }
}

/**
 * Remove the lock file if this process owns it.
 */
function releaseLock(): void {
  const lockPath = getLockPath(getServerPort());
  const data = readLockFile(lockPath);
  if (data?.pid === process.pid) {
    removeLockFile(lockPath);
  }
}

// Track server instance (singleton pattern)
let serverInstance: FastifyInstance | null = null;

/**
 * Make an HTTP request to the FastAPI backend using fetch
 * @param {string} method The HTTP method
 * @param {string} endpoint The API endpoint
 * @param {Object} data The request payload
 * @param {string} incomingAuthHeader The incoming Authorization header
 * @returns {Promise<Object>} The response data
 */

/**
 * Call backend API with streaming support
 * @param {string} method HTTP method
 * @param {string} endpoint API endpoint
 * @param {Object} data Request data
 * @param {string} incomingAuthHeader Authorization header
 * @param {Function} onStreamEvent Callback for stream events
 * @returns {Promise<Object>} Final API response
 */
async function callBackendApiStreaming<TReturn>(
  method: string,
  endpoint: string,
  data: unknown,
  incomingAuthHeader: string | undefined,
  onStreamEvent?: (event: StreamingEvent) => void
): Promise<TReturn> {
  // Backend API settings
  const apiHost = process.env.CODEPRESS_BACKEND_HOST || "localhost";
  const apiPort = parseInt(process.env.CODEPRESS_BACKEND_PORT || "8007", 10);
  const apiPath = endpoint.startsWith("/")
    ? endpoint.replace("/", "")
    : endpoint;
  const protocol =
    apiHost === "localhost" || apiHost === "127.0.0.1" ? "http" : "https";
  const url = `${protocol}://${apiHost}:${apiPort}/${apiPath}`;

  const requestOptions: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  } = {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
  };

  if (incomingAuthHeader) {
    requestOptions.headers.Authorization = incomingAuthHeader;
  }

  if (data) {
    requestOptions.body = JSON.stringify(data);
  }

  try {
    console.log(
      `\x1b[36mℹ Calling backend streaming API: ${method} ${url}\x1b[0m`
    );
    const response = await fetch(url, requestOptions);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Backend API error (${response.status}): ${errorText}`);
    }

    // Handle streaming response
    if (
      response.headers.get("content-type")?.includes("text/event-stream") &&
      onStreamEvent
    ) {
      const body = response.body;
      if (!body) {
        throw new Error("Backend streaming response has no body");
      }

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let finalResult: unknown = null;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const eventData = JSON.parse(line.slice(6));

                // Forward the event to the client
                if (onStreamEvent) {
                  onStreamEvent(eventData);
                }

                // Capture final result if this is a completion event
                if (eventData.type === "final_result") {
                  finalResult = eventData.result;
                } else if (eventData.type === "complete") {
                  // Use the last result we captured
                  break;
                }
              } catch (parseError) {
                console.error(
                  "Error parsing SSE data:",
                  parseError,
                  "Line:",
                  line
                );
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Return the agent's final result payload; may be undefined if no final_result arrived
      return finalResult as TReturn;
    } else {
      // Fallback to regular JSON response
      return (await response.json()) as TReturn;
    }
  } catch (error) {
    console.error(
      `\x1b[31m✗ Backend streaming API call failed: ${error.message}\x1b[0m`
    );
    throw error;
  }
}

async function callBackendApi<TReturn>(
  method: string,
  endpoint: string,
  data: unknown,
  incomingAuthHeader: string | undefined
): Promise<TReturn> {
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
        `\x1b[36mℹ Using incoming Authorization header for authentication\x1b[0m`
      );
    }

    // Prepare headers with authentication if token exists
    const headers: Record<string, string> = {
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
      return JSON.parse(responseText) as TReturn;
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
 * Service: Save image data to file system
 * @param {Object} params - Function parameters
 * @param {string} params.imageData - Base64 image data
 * @param {string} params.filename - Optional filename
 * @returns {Promise<string|null>} The saved image path or null if failed
 */
async function saveImageData({
  imageData,
  filename,
}: {
  imageData?: string;
  filename?: string;
}): Promise<string | null> {
  if (!imageData) return null;

  try {
    const imageDir = path.join(process.cwd(), "public");
    if (!fs.existsSync(imageDir)) {
      fs.mkdirSync(imageDir, { recursive: true });
      console.log(`\x1b[36mℹ Created directory: ${imageDir}\x1b[0m`);
    }

    let imagePath: string;
    let base64Data: string;

    if (filename) {
      imagePath = path.join(imageDir, filename);
      // When filename is provided, assume image_data is just the base64 string
      const match = imageData.match(/^data:image\/[\w+]+\;base64,(.+)$/);
      if (match?.[1]) {
        base64Data = match[1]; // Extract if full data URI is sent
      } else {
        base64Data = imageData; // Assume raw base64
      }
      console.log(`\x1b[36mℹ Using provided filename: ${filename}\x1b[0m`);
    } else {
      // Fallback to existing logic if filename is not provided
      const match = imageData.match(/^data:image\/([\w+]+);base64,(.+)$/);
      let imageExtension: string;

      if (match?.[1] && match?.[2]) {
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
function readFileFromEncodedLocation(encodedLocation: string): {
  filePath: string;
  targetFile: string;
  fileContent: string;
} {
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
async function getChanges({
  githubRepoName,
  fileChanges,
  authHeader,
}: {
  githubRepoName?: string;
  fileChanges: BackendFileChange[];
  authHeader?: string;
}): Promise<GetChangesResponsePayload> {
  console.log(
    `\x1b[36mℹ Getting changes from backend for ${fileChanges.length} files\x1b[0m`
  );

  return await callBackendApi<GetChangesResponsePayload>(
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
 * Service: Apply full file replacement and format code
 * @param {string} modifiedContent The complete new file content
 * @param {string} targetFile Target file path
 * @returns {Promise<string>} Formatted code
 */
function pickPrettierParser(filePath: string): prettier.BuiltInParserName {
  const lower = (filePath || "").toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  return "babel"; // default for .js/.jsx and others
}

async function tryFormatWithPrettierOrNull(
  code: string,
  filePath: string
): Promise<string | null> {
  try {
    const result = await Promise.resolve(
      prettier.format(code, {
        parser: pickPrettierParser(filePath),
        semi: true,
        singleQuote: false,
      })
    );
    return result;
  } catch (err) {
    console.error("Error formatting code with Prettier:", err);
    return null;
  }
}

function closeUnclosedJsxTags(code: string): string {
  try {
    const tagRegex = /<\/?([A-Za-z][A-Za-z0-9]*)\b[^>]*?\/?>(?!\s*<\!)/g;
    const selfClosingRegex = /<([A-Za-z][A-Za-z0-9]*)\b[^>]*?\/>/;
    const stack = [];
    while (true) {
      const nextMatch = tagRegex.exec(code);
      if (nextMatch === null) break;
      const full = nextMatch[0];
      const name = nextMatch[1];
      const isClose = full.startsWith("</");
      const isSelfClosing = selfClosingRegex.test(full);
      if (isSelfClosing) continue;
      if (!isClose) {
        stack.push(name);
      } else {
        if (stack.length && stack[stack.length - 1] === name) {
          stack.pop();
        } else {
          const idx = stack.lastIndexOf(name);
          if (idx !== -1) stack.splice(idx, 1);
        }
      }
    }
    if (stack.length === 0) return code;
    let suffix = "";
    for (let i = stack.length - 1; i >= 0; i--) {
      const tag = stack[i];
      suffix += `</${tag}>`;
    }
    return code + "\n" + suffix + "\n";
  } catch {
    return code;
  }
}

async function applyFullFileReplacement(
  modifiedContent: FullFileReplacement,
  targetFile: string
): Promise<string> {
  console.log(`\x1b[36mℹ Applying full file replacement\x1b[0m`);

  // Ensure folder
  try {
    const dir = path.dirname(targetFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`\x1b[36mℹ Created directory: ${dir}\x1b[0m`);
    }
  } catch (mkdirErr) {
    console.error(
      `\x1b[31m✗ Failed to ensure directory for ${targetFile}: ${mkdirErr.message}\x1b[0m`
    );
  }

  let formattedCode = "";
  if (typeof modifiedContent === "string") {
    // Format with Prettier
    try {
      formattedCode = await prettier.format(modifiedContent, {
        parser: pickPrettierParser(targetFile),
        semi: true,
        singleQuote: false,
      });
    } catch (prettierError) {
      console.error("Prettier formatting failed:", prettierError);
      // If formatting fails, use the unformatted code
      formattedCode = modifiedContent;
    }
    fs.writeFileSync(targetFile, formattedCode, "utf8");
  } else if (modifiedContent.type === "binary" && modifiedContent.base64) {
    const buffer = Buffer.from(modifiedContent.base64, "base64");
    formattedCode = "binary_encoded_file";
    fs.writeFileSync(targetFile, buffer);
  } else {
    console.warn(`Unknown file type for ${targetFile}, skipping`);
    formattedCode = "";
  }

  console.log(
    `\x1b[32m✓ Updated file ${targetFile} with complete file replacement\x1b[0m`
  );

  return formattedCode;
}

/**
 * Handle streaming agent requests with Server-Sent Events
 * @param {Object} params - Function parameters
 * @param {Object} params.request - Fastify request object
 * @param {Object} params.reply - Fastify reply object
 * @param {Object} params.data - Request body data
 * @param {string} params.authHeader - Authorization header
 * @param {string} params.fileContent - The file content to process
 */
async function handleStreamingAgentRequest({
  reply,
  data,
  authHeader,
  fileContent,
}: StreamingAgentRequestArgs): Promise<void> {
  const { encoded_location, github_repo_name, user_instruction, branch_name } =
    data;

  // Debug request
  console.log("[engine] handleStreamingAgentRequest start", {
    encoded_location,
    github_repo_name,
    branch_name,
    user_instruction_len:
      typeof user_instruction === "string"
        ? user_instruction.length
        : undefined,
    hasAuth: !!authHeader,
  });
  // Set up Server-Sent Events headers
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Cache-Control",
  });

  // Apply incremental updates to disk for hot reload
  async function writeIncrementalUpdate(
    eventData: StreamingEvent
  ): Promise<void> {
    try {
      console.log("[engine] writeIncrementalUpdate begin", {
        type: eventData?.type,
        file_path: eventData?.file_path,
      });
      if (
        eventData &&
        eventData.type === "file_update" &&
        eventData.file_path &&
        typeof eventData.content === "string"
      ) {
        // Normalize .tmp paths emitted by editors before writing
        let normalizedPath = eventData.file_path;
        if (normalizedPath.includes(".tmp.")) {
          const tmpIdx = normalizedPath.indexOf(".tmp.");
          normalizedPath = normalizedPath.slice(0, tmpIdx);
        }
        const targetFilePath = toAbsolutePath(normalizedPath);
        const candidate = eventData.content;
        let formatted = await tryFormatWithPrettierOrNull(
          candidate,
          targetFilePath
        );
        if (!formatted) {
          const closed = closeUnclosedJsxTags(candidate);
          formatted = await tryFormatWithPrettierOrNull(closed, targetFilePath);
        }
        if (formatted) {
          await applyFullFileReplacement(formatted, targetFilePath);
        } else {
          console.warn(
            "Skipping incremental write due to unparseable content for",
            targetFilePath
          );
        }
      }
      if (
        eventData &&
        eventData.type === "final_result" &&
        eventData.result &&
        eventData.result.updated_files
      ) {
        const updatedEntries = Object.entries(
          eventData.result.updated_files as Record<string, string>
        );
        for (const [filePath, newContent] of updatedEntries) {
          let p = filePath;
          if (p.includes(".tmp.")) {
            p = p.slice(0, p.indexOf(".tmp."));
          }
          const targetFilePath = toAbsolutePath(p);
          let formatted = await tryFormatWithPrettierOrNull(
            newContent,
            targetFilePath
          );
          if (!formatted) {
            const closed = closeUnclosedJsxTags(newContent);
            formatted = await tryFormatWithPrettierOrNull(
              closed,
              targetFilePath
            );
          }
          await applyFullFileReplacement(
            formatted ?? newContent,
            targetFilePath
          );
        }
      }
    } catch (e) {
      console.error("Failed to apply incremental update:", e);
    }
  }

  // Function to send SSE data
  function sendEvent(eventData: StreamingEvent): void {
    const data = JSON.stringify(eventData);
    reply.raw.write(`data: ${data}\n\n`);
  }

  try {
    // Call the backend for agent changes with streaming
    // The backend will handle all streaming events from the agent
    const backendResponse =
      await callBackendApiStreaming<GetAgentChangesStreamingFinal>(
        "POST",
        "v1/code-sync/get-agent-changes",
        {
          github_repo_name: github_repo_name,
          encoded_location: encoded_location,
          file_content: fileContent,
          branch_name: branch_name,
          user_instruction: user_instruction,
        },
        authHeader,
        async (evt) => {
          console.log("[engine] stream event", {
            type: (evt as any)?.type,
            file_path: (evt as any)?.file_path,
            success: (evt as any)?.success,
          });
          await writeIncrementalUpdate(evt);
          sendEvent(evt);
        }
      );

    console.log(
      `\x1b[36mℹ backendResponse to agent: ${JSON.stringify(backendResponse)}\x1b[0m`
    );

    // Handle the response and apply changes
    if (backendResponse?.updated_files) {
      const updatedFilePaths: string[] = [];
      const updatedEntries = Object.entries(backendResponse.updated_files);
      for (const [filePath, newContent] of updatedEntries) {
        const targetFilePath = toAbsolutePath(filePath);
        await applyFullFileReplacement(newContent, targetFilePath);
        updatedFilePaths.push(filePath);
      }

      // Send final success event
      sendEvent({
        type: "final_result",
        result: {
          success: true,
          updated_file_paths: updatedFilePaths,
        },
        success: true,
        message: `✅ Changes applied successfully to ${updatedFilePaths.length} file(s)!`,
        ephemeral: false,
      });
    } else {
      console.log(backendResponse);
      throw new Error("No valid response from backend");
    }

    // Send completion event
    sendEvent({ type: "complete" });
  } catch (error) {
    console.error(
      `\x1b[31m✗ Error in streaming agent: ${error.message}\x1b[0m`
    );
    sendEvent({
      type: "error",
      error: error.message,
      ephemeral: false,
    });
  }

  reply.raw.end();
}

/**
 * Create and configure the Fastify app
 * @returns {Object} The configured Fastify instance
 */
function createApp(): FastifyInstance {
  const app = fastify({
    logger: false, // Disable built-in logging since we have custom logging
  });

  // Register CORS plugin
  app.register(cors, {
    origin: "*",
    methods: ["GET", "POST", "OPTIONS", "PUT", "PATCH", "DELETE"],
    allowedHeaders: [
      "X-Requested-With",
      "content-type",
      "Authorization",
      "Cache-Control",
      "Accept",
    ],
    credentials: true,
  });

  // Ping route
  app.get("/ping", async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).type("text/plain").send("pong");
  });

  // Meta route
  app.get("/meta", async (_request: FastifyRequest, reply: FastifyReply) => {
    // Try to get package version but don't fail if not available
    let version = "0.0.0";
    try {
      // In production builds, use a relative path that works with the installed package structure
      version = require("../package.json").version;
    } catch (err) {
      console.error("Error getting package version:", err);
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
  app.get(
    "/project-structure",
    async (_request: FastifyRequest, reply: FastifyReply) => {
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
    }
  );

  // Visual editor API route for regular agent changes
  app.post(
    "/visual-editor-api",
    async (
      request: FastifyRequest<{ Body: VisualEditorApiBody }>,
      reply: FastifyReply
    ) => {
      try {
        const { changes, github_repo_name } = request.body;
        const authHeader =
          request.headers.authorization || request.headers["authorization"];

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

        const changesWithDimensions = changes.filter(
          (change) => change.browser_width && change.browser_height
        );
        if (changesWithDimensions.length > 0) {
          const sampleChange = changesWithDimensions[0];
          console.log(
            `\x1b[36mℹ Browser dimensions detected: ${sampleChange.browser_width}x${sampleChange.browser_height}\x1b[0m`
          );
        } else {
          console.log(
            `\x1b[33m⚠ No browser dimensions found in changes\x1b[0m`
          );
        }

        const uniqueEncodedLocations = new Set<string>();
        const validChanges: VisualEditorChange[] = [];

        for (const change of changes) {
          console.log(`\x1b[36mℹ change: ${JSON.stringify(change)}\x1b[0m`);

          try {
            if (!change.encoded_location) {
              console.warn(
                `\x1b[33m⚠ Skipping change with missing encoded_location.\x1b[0m`
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

            const hasStyleChanges =
              change.style_changes && change.style_changes.length > 0;
            const hasTextChanges =
              change.text_changes && change.text_changes.length > 0;
            const hasMoveChanges =
              change.move_changes && change.move_changes.length > 0;

            if (!hasStyleChanges && !hasTextChanges && !hasMoveChanges) {
              console.warn(
                `\x1b[33m⚠ Skipping change with no style, text, or move changes.\x1b[0m`
              );
              continue;
            }

            uniqueEncodedLocations.add(change.encoded_location);
            validChanges.push(change);
          } catch (err) {
            console.error(
              `\x1b[31m✖ Error processing change for location: ${change.encoded_location}\x1b[0m`,
              err
            );
          }
        }

        const fileContentMap = new Map<string, string>();
        uniqueEncodedLocations.forEach((encodedLocation) => {
          try {
            const { fileContent } =
              readFileFromEncodedLocation(encodedLocation);
            fileContentMap.set(encodedLocation, fileContent);
          } catch (err) {
            console.error(
              `\x1b[31m✖ Error reading file for location: ${encodedLocation}\x1b[0m`,
              err
            );
          }
        });

        console.log(
          `\x1b[36mℹ Pre-fetched ${fileContentMap.size} unique files for ${validChanges.length} changes\x1b[0m`
        );

        const fileChangesForBackend: BackendFileChange[] = [];
        for (const change of validChanges) {
          try {
            const fileContent = fileContentMap.get(change.encoded_location);
            if (!fileContent) {
              console.warn(
                `\x1b[33m⚠ Skipping change with missing file content for: ${change.encoded_location}\x1b[0m`
              );
              continue;
            }

            fileChangesForBackend.push({
              encoded_location: change.encoded_location,
              file_content: fileContent,
              changes: [
                {
                  style_changes: change.style_changes || [],
                  text_changes: change.text_changes || [],
                  move_changes: change.move_changes || [],
                },
              ],
              browser_width: change.browser_width,
              browser_height: change.browser_height,
            });
          } catch (err) {
            console.error(
              `\x1b[31m✖ Error processing change for location: ${change.encoded_location}\x1b[0m`,
              err
            );
          }
        }

        for (const change of changes) {
          if (change.image_data && change.filename) {
            await saveImageData({
              imageData: change.image_data,
              filename: change.filename,
            });
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

        const updatedFiles = new Set<string>();
        if (backendResponse?.updated_files) {
          console.log(`\x1b[36mℹ Processing updated_files format\x1b[0m`);
          const updatedEntries = Object.entries(backendResponse.updated_files);
          for (const [filePath, newContent] of updatedEntries) {
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
    }
  );

  // Visual editor API route for agent changes
  app.post(
    "/visual-editor-api-agent",
    async (
      request: FastifyRequest<{ Body: VisualEditorAgentBody }>,
      reply: FastifyReply
    ) => {
      try {
        const data = request.body;
        const { encoded_location, image_data, filename } = data;
        const authHeader =
          request.headers.authorization || request.headers["authorization"];

        console.log(
          `\x1b[36mℹ [visual-editor-api-agent] Auth header received: ${authHeader ? "[PRESENT]" : "[MISSING]"}, Always streaming\x1b[0m`
        );
        console.log("[engine] /visual-editor-api-agent", {
          encoded_location,
          hasImage: !!image_data,
          filename,
        });

        if (!encoded_location) {
          return reply.code(400).send({ error: "Missing encoded_location" });
        }

        const { fileContent } = readFileFromEncodedLocation(encoded_location);

        // Save image data before processing
        await saveImageData({ imageData: image_data, filename });

        // Always use streaming for agent requests
        return await handleStreamingAgentRequest({
          reply,
          data,
          authHeader,
          fileContent,
        });
      } catch (err) {
        console.error(`Error in /visual-editor-api-agent: ${err.message}`);
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  // Endpoint to write files to local filesystem (for local mode)
  app.post(
    "/write-files",
    async (
      request: FastifyRequest<{ Body: WriteFilesBody }>,
      reply: FastifyReply
    ) => {
      try {
        const { updated_files } = request.body;
        console.log("[engine] /write-files incoming", {
          files: updated_files ? Object.keys(updated_files).length : 0,
        });

        if (!updated_files || typeof updated_files !== "object") {
          return reply.code(400).send({
            error: "Missing or invalid updated_files object",
          });
        }

        const writtenFiles: string[] = [];
        const updatedEntries = Object.entries(
          updated_files as Record<string, string>
        );
        for (const [rawPath, newContent] of updatedEntries) {
          try {
            let filePath = rawPath;
            if (filePath.includes(".tmp.")) {
              filePath = filePath.slice(0, filePath.indexOf(".tmp."));
            }
            const targetFilePath = toAbsolutePath(filePath);
            await applyFullFileReplacement(newContent, targetFilePath);
            writtenFiles.push(targetFilePath);
            console.log(`\x1b[32m✓ Wrote ${targetFilePath} to disk\x1b[0m`);
          } catch (writeErr) {
            console.error(
              `\x1b[31m✗ Failed to write ${rawPath}: ${writeErr.message}\x1b[0m`
            );
          }
        }

        return reply.code(200).send({
          success: true,
          written_files: writtenFiles,
        });
      } catch (err) {
        console.error(`\x1b[31m✗ Error in /write-files: ${err.message}\x1b[0m`);
        return reply.code(500).send({ error: err.message });
      }
    }
  );

  return app;
}

/**
 * Starts the Codepress development server if not already running
 * @param {Object} options Server configuration options
 * @param {number} [options.port=4321] Port to run the server on
 * @returns {Object|null} The Fastify instance or null if already running
 */
async function startServer(
  options: StartServerOptions = {}
): Promise<FastifyInstance | null> {
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
  const port = options.port ?? getServerPort();

  try {
    // Create the Fastify app
    const app = createApp();

    // Ensure lock is released when Fastify closes
    app.addHook("onClose", () => {
      releaseLock();
    });

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
    // On startup failure, best-effort release
    releaseLock();
    return null;
  }
}

/**
 * Check if a relative path should be excluded based on ignore patterns.
 * @param {string} relativePath - The path relative to the base directory.
 * @param {RegExp[]} excludePatterns - Compiled ignore patterns.
 * @returns {boolean} True if the path matches any exclude pattern.
 */
function shouldExclude(
  relativePath: string,
  excludePatterns: RegExp[]
): boolean {
  return excludePatterns.some((pattern) => pattern.test(relativePath));
}

/**
 * Recursively collects file paths from a directory, respecting exclude patterns.
 * @param {string} dir - Directory to traverse.
 * @param {RegExp[]} excludePatterns - Compiled ignore patterns.
 * @param {string} [baseDir=dir] - Base directory used to compute relative paths.
 * @returns {string[]} A list of file paths relative to baseDir.
 */
function getFilesRecursively(
  dir: string,
  excludePatterns: RegExp[],
  baseDir: string = dir
): string[] {
  const files: string[] = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (shouldExclude(relativePath, excludePatterns)) {
        continue;
      }

      if (entry.isDirectory()) {
        files.push(...getFilesRecursively(fullPath, excludePatterns, baseDir));
      } else if (entry.isFile()) {
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

/**
 * Get a list of files in the current project, respecting gitignore patterns
 * @returns {string} List of file paths, one per line
 */
function getProjectStructure(): string {
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
        .filter((regex): regex is RegExp => regex !== null); // Remove null entries with type guard

      // Combine default patterns with gitignore patterns
      excludePatterns = [...excludePatterns, ...gitignorePatterns];

      console.log(
        `\x1b[36mℹ Found ${gitignorePatterns.length} valid gitignore patterns\x1b[0m`
      );
    } else {
      console.log(
        `\x1b[33m⚠ No .gitignore file found, no exclusions applied\x1b[0m`
      );
    }

    const fileList = getFilesRecursively(process.cwd(), excludePatterns);
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

interface ServerModule {
  startServer: typeof startServer;
  createApp: typeof createApp;
  getProjectStructure: typeof getProjectStructure;
  server?: FastifyInstance | null;
}

const serverModule: ServerModule = {
  startServer,
  createApp,
  getProjectStructure,
};

if (process.env.NODE_ENV !== "production") {
  (async () => {
    try {
      serverModule.server = await startServer();
    } catch (err) {
      console.error("Failed to auto-start server:", err);
    }
  })();
}

export { createApp, getProjectStructure, startServer };
export type { ServerModule };

module.exports = serverModule;
