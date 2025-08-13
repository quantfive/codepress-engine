/**
 * @fileoverview File operations service for CodePress
 * Handles file reading, writing, and path operations
 */

const fs = require("fs");
const path = require("path");
const prettier = require("prettier");
const { decode } = require("../utils/encoding");
const { createLogger } = require("../utils/logger");

// Create logger instance for file service
const logger = createLogger("fileService");

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
 * Read file content from encoded location
 * @param {string} encodedLocation - The encoded file location
 * @returns {Object} File data with path and content
 */
function readFileFromEncodedLocation(encodedLocation) {
  const encodedFilePath = encodedLocation.split(":")[0];
  const filePath = decode(encodedFilePath);
  logger.debug("Decoded file path", { filePath });

  // If filePath is absolute, use it directly. Otherwise, join with cwd.
  const targetFile = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);

  logger.debug("Reading file", { targetFile });
  const fileContent = fs.readFileSync(targetFile, "utf8");

  return { filePath, targetFile, fileContent };
}

/**
 * Apply full file replacement and format code
 * @param {string} modifiedContent - The complete new file content
 * @param {string} targetFile - Target file path
 * @returns {Promise<string>} Formatted code
 */
async function applyFullFileReplacement(modifiedContent, targetFile) {
  logger.debug("Applying full file replacement", { targetFile });

  // Format with Prettier
  let formattedCode;
  try {
    formattedCode = await prettier.format(modifiedContent, {
      parser: "typescript",
      semi: true,
      singleQuote: false,
    });
  } catch (prettierError) {
    logger.warn("Prettier formatting failed, using unformatted code", {
      error: prettierError.message,
      targetFile
    });
    // If formatting fails, use the unformatted code
    formattedCode = modifiedContent;
  }

  // Write back to file
  fs.writeFileSync(targetFile, formattedCode, "utf8");

  logger.success("File updated with complete replacement", { targetFile });

  return formattedCode;
}

/**
 * Save image data to file system
 * @param {string} imageData - Base64 image data
 * @param {string} filename - Optional filename
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
      logger.info("Created image directory", { imageDir });
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
      logger.debug("Using provided filename", { filename });
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
        logger.warn("Image data URI prefix not found and no filename provided, defaulting to .png extension");
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
    logger.success("Image saved successfully", { imagePath });
    return imagePath;
  } catch (imgError) {
    logger.error("Failed to save image", { error: imgError.message });
    return null;
  }
}

module.exports = {
  toAbsolutePath,
  readFileFromEncodedLocation,
  applyFullFileReplacement,
  saveImageData,
};