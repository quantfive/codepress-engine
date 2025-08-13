/**
 * @fileoverview Text transformation service for CodePress
 * Handles line-based and pattern-based text changes
 */

const prettier = require("prettier");
const fs = require("fs");
const { createLogger } = require("../utils/logger");

// Create logger instance for text change service
const logger = createLogger("textChangeService");

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
        logger.warn("Invalid replace change object", { change });
      }
      break;

    case "delete":
      if (startIdx !== undefined && endIdx !== undefined) {
        lines.splice(startIdx, endIdx - startIdx + 1);
      } else {
        logger.warn("Invalid delete change object", { change });
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
        logger.warn("Invalid insert change object", { change });
      }
      break;

    default:
      logger.warn("Unknown change type", { type, change });
    }
  }

  return lines.join("\n");
}

/**
 * Apply pattern-based changes to file content
 * @param {string} fileContent - The original file content
 * @param {Array<Object>} changes - Array of pattern-based change objects
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
        logger.warn("Multiple changes target the same pattern", {
          existingIndex: existingIndex + 1,
          currentIndex: index + 1,
          existingExplanation: changes[existingIndex].explanation,
          currentExplanation: change.explanation,
          pattern: change.find.substring(0, 100) + "..."
        });
      } else {
        findPatterns.set(change.find, index);
      }
    }
  });

  for (const change of changes) {
    const { type, find, replaceWith, insert, explanation } = change;

    logger.debug("Applying change", { type, explanation });

    switch (type) {
    case "replace":
      if (find && replaceWith !== undefined) {
        if (modifiedContent.includes(find)) {
          // Check if replaceWith contains malformed JSX
          const openTags = (replaceWith.match(/<[^\/][^>]*>/g) || []).length;
          const closeTags = (replaceWith.match(/<\/[^>]*>/g) || []).length;

          if (openTags !== closeTags) {
            logger.warn("Potential JSX malformation detected", {
              openTags,
              closeTags,
              replacement: replaceWith.substring(0, 200) + "..."
            });
          }

          modifiedContent = modifiedContent.replace(find, replaceWith);
          logger.debug("Pattern replaced successfully");
        } else {
          logger.warn("Pattern not found for replace", {
            pattern: find.substring(0, 50) + "...",
            reason: "Previous change may have modified content"
          });
        }
      } else {
        logger.warn("Invalid replace change object", { change });
      }
      break;

    case "insertAfter":
      if (find && insert !== undefined) {
        if (modifiedContent.includes(find)) {
          modifiedContent = modifiedContent.replace(find, find + insert);
          logger.debug("Content inserted after pattern successfully");
        } else {
          logger.warn("Pattern not found for insertAfter", {
            pattern: find.substring(0, 50) + "..."
          });
        }
      } else {
        logger.warn("Invalid insertAfter change object", { change });
      }
      break;

    case "insertBefore":
      if (find && insert !== undefined) {
        if (modifiedContent.includes(find)) {
          modifiedContent = modifiedContent.replace(find, insert + find);
          logger.debug("Content inserted before pattern successfully");
        } else {
          logger.warn("Pattern not found for insertBefore", {
            pattern: find.substring(0, 50) + "..."
          });
        }
      } else {
        logger.warn("Invalid insertBefore change object", { change });
      }
      break;

    case "delete":
      if (find) {
        if (modifiedContent.includes(find)) {
          modifiedContent = modifiedContent.replace(find, "");
          logger.debug("Pattern deleted successfully");
        } else {
          logger.warn("Pattern not found for delete", {
            pattern: find.substring(0, 50) + "..."
          });
        }
      } else {
        logger.warn("Invalid delete change object", { change });
      }
      break;

    default:
      logger.warn("Unknown change type", { type });
    }
  }

  return modifiedContent;
}

/**
 * Apply changes and format code
 * @param {string} fileContent - Original file content
 * @param {Array} changes - Array of changes to apply
 * @param {string} targetFile - Target file path
 * @param {boolean} usePatternChanges - Whether to use pattern-based changes (true) or text-based changes (false)
 * @returns {Promise<string>} Formatted code
 */
async function applyChangesAndFormat(
  fileContent,
  changes,
  targetFile,
  usePatternChanges = true
) {
  logger.info("Received changes from backend", {
    changesCount: changes.length,
    usePatternChanges
  });

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
    logger.warn("Prettier formatting failed, using unformatted code", {
      error: prettierError.message,
      targetFile
    });
    // If formatting fails, use the unformatted code
    formattedCode = modifiedContent;
  }

  // Write back to file
  fs.writeFileSync(targetFile, formattedCode, "utf8");

  logger.success("File updated with changes", {
    targetFile,
    changesCount: changes.length,
    approach: usePatternChanges ? "pattern-based" : "text-based"
  });

  return formattedCode;
}

module.exports = {
  applyTextChanges,
  applyPatternChanges,
  applyChangesAndFormat,
};