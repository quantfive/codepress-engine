/**
 * @fileoverview File operations service for CodePress
 * Handles file reading, writing, and path operations
 */

import * as fs from "fs";
import * as path from "path";
import * as prettier from "prettier";
import { decode } from "../utils/encoding";
import { createLogger } from "../utils/logger";
import type { FileData } from "../types";

// Create logger instance for file service
const logger = createLogger("fileService");

/**
 * Normalizes a possibly-relative or malformed absolute path into an absolute path.
 * - Uses CWD for relative paths
 * - Fixes common case where macOS absolute paths lose their leading slash (e.g., "Users/...")
 */
export function toAbsolutePath(inputPath: string): string {
  if (!inputPath) {
    return inputPath;
  }
  const trimmedPath: string = String(inputPath).trim();

  // Fix macOS-like absolute paths missing the leading slash, e.g. "Users/..."
  const looksLikePosixAbsNoSlash: boolean =
    process.platform !== "win32" &&
    (trimmedPath.startsWith("Users" + path.sep) ||
      trimmedPath.startsWith("Volumes" + path.sep));

  const candidate: string = looksLikePosixAbsNoSlash
    ? path.sep + trimmedPath
    : trimmedPath;

  return path.isAbsolute(candidate)
    ? candidate
    : path.join(process.cwd(), candidate);
}

/**
 * Read file content from encoded location
 */
export function readFileFromEncodedLocation(encodedLocation: string): FileData {
  const encodedFilePath: string = encodedLocation.split(":")[0];
  const filePath: string = decode(encodedFilePath);
  logger.debug("Decoded file path", { filePath });

  // If filePath is absolute, use it directly. Otherwise, join with cwd.
  const targetFile: string = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);

  logger.debug("Reading file", { targetFile });
  const fileContent: string = fs.readFileSync(targetFile, "utf8");

  return { filePath, targetFile, fileContent };
}

/**
 * Save image data to file system
 */
export async function saveImageData(imageData?: string, filename?: string): Promise<string | null> {
  if (!imageData) {
    return null;
  }

  try {
    const imageDir: string = path.join(process.cwd(), "public");
    if (!fs.existsSync(imageDir)) {
      fs.mkdirSync(imageDir, { recursive: true });
      logger.info("Created image directory", { imageDir });
    }

    let imagePath: string;
    let base64Data: string;

    if (filename) {
      imagePath = path.join(imageDir, filename);
      // When filename is provided, assume image_data is just the base64 string
      const match: RegExpMatchArray | null = imageData.match(/^data:image\/[\w+]+\;base64,(.+)$/);
      if (match && match[1]) {
        base64Data = match[1]; // Extract if full data URI is sent
      } else {
        base64Data = imageData; // Assume raw base64
      }
      logger.debug("Using provided filename", { filename });
    } else {
      // Fallback to existing logic if filename is not provided
      const match: RegExpMatchArray | null = imageData.match(/^data:image\/([\w+]+);base64,(.+)$/);
      let imageExtension: string;

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

      const imageName: string = `image_${Date.now()}.${imageExtension}`;
      imagePath = path.join(imageDir, imageName);
    }

    const imageBuffer: Buffer = Buffer.from(base64Data, "base64");
    fs.writeFileSync(imagePath, imageBuffer);
    logger.success("Image saved successfully", { imagePath });
    return imagePath;
  } catch (imgError) {
    logger.error("Failed to save image", { error: (imgError as Error).message });
    return null;
  }
}

/**
 * Apply full file replacement and format code
 */
export async function applyFullFileReplacement(modifiedContent: string, targetFile: string): Promise<string> {
  logger.debug("Applying full file replacement", { targetFile });

  // Format with Prettier
  let formattedCode: string;
  try {
    formattedCode = await prettier.format(modifiedContent, {
      parser: "typescript",
      semi: true,
      singleQuote: false,
    });
  } catch (prettierError) {
    logger.warn("Prettier formatting failed, using unformatted code", {
      error: (prettierError as Error).message,
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