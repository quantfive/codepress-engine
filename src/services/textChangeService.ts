/**
 * @fileoverview Text transformation service for CodePress
 * Handles line-based and pattern-based text changes
 */

import * as prettier from "prettier";
import * as fs from "fs";
import { createLogger } from "../utils/logger";
import type { TextChange, PatternChange } from "../types";

// Create logger instance for text change service
const logger = createLogger("textChangeService");

/**
 * Apply text-based changes to file content using line-based operations
 * Changes are processed in reverse order to prevent line number shifts
 */
export function applyTextChanges(fileContent: string, changes: TextChange[]): string {
  const lines: string[] = fileContent.split("\n");

  // Sort changes by the highest line number involved (endLine or line) in reverse order
  // to avoid index shifts during modification.
  const sortedChanges: TextChange[] = [...changes].sort((a, b) => {
    const lineA: number = a.type === "insert" ? (a.line || 0) : (a.endLine || 0);
    const lineB: number = b.type === "insert" ? (b.line || 0) : (b.endLine || 0);
    return lineB - lineA;
  });

  for (const change of sortedChanges) {
    const { type } = change;

    // Convert line numbers to 0-based indices for array operations
    const startIdx: number | undefined = change.startLine ? change.startLine - 1 : undefined;
    const endIdx: number | undefined = change.endLine ? change.endLine - 1 : undefined;
    const lineIdx: number | undefined = change.line ? change.line - 1 : undefined; // For insert

    switch (type) {
    case "replace":
      if (
        startIdx !== undefined &&
          endIdx !== undefined &&
          change.codeChange !== undefined
      ) {
        // Decode newline characters within the codeChange string
        const decodedCodeChange: string = change.codeChange.replace(/\\n/g, "\n");
        const replacementLines: string[] = decodedCodeChange.split("\n");
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
        const decodedCodeChange: string = change.codeChange.replace(/\\n/g, "\n");
        // Insert *after* the specified line index
        const insertionLines: string[] = decodedCodeChange.split("\n");
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
 */
export function applyPatternChanges(fileContent: string, changes: PatternChange[]): string {
  let modifiedContent: string = fileContent;

  // Detect potential conflicts by checking for duplicate find patterns
  const findPatterns = new Map<string, number>();
  changes.forEach((change, index) => {
    if (change.find) {
      if (findPatterns.has(change.find)) {
        const existingIndex: number = findPatterns.get(change.find)!;
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
          const openTags: number = (replaceWith.match(/<[^\/][^>]*>/g) || []).length;
          const closeTags: number = (replaceWith.match(/<\/[^>]*>/g) || []).length;

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
 */
export async function applyChangesAndFormat(
  fileContent: string,
  changes: (TextChange | PatternChange)[],
  targetFile: string,
  usePatternChanges: boolean = true
): Promise<string> {
  logger.info("Received changes from backend", {
    changesCount: changes.length,
    usePatternChanges
  });

  // Apply the changes using the appropriate function based on the flag
  const modifiedContent: string = usePatternChanges
    ? applyPatternChanges(fileContent, changes as PatternChange[])
    : applyTextChanges(fileContent, changes as TextChange[]);

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

  logger.success("File updated with changes", {
    targetFile,
    changesCount: changes.length,
    approach: usePatternChanges ? "pattern-based" : "text-based"
  });

  return formattedCode;
}