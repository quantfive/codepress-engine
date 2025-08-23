/**
 * @fileoverview Request validation service for CodePress
 * Handles validation of incoming requests and data
 */

import type { ValidationResult, ChangeRequest } from "../types";

interface RequestData {
  encoded_location?: string;
  old_html?: string;
  new_html?: string;
  aiInstruction?: string;
  ai_instruction?: string;
}

/**
 * Validate request data based on mode
 */
export function validateRequestData(data: RequestData, isAiMode: boolean): ValidationResult {
  const {
    encoded_location,
    old_html,
    new_html,
    aiInstruction,
    ai_instruction,
  } = data;

  const actualAiInstruction: string | undefined = ai_instruction || aiInstruction;
  
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
    const missingFields: string[] = [];
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
 * Validate that changes have actual content
 */
export function hasValidContent(change: ChangeRequest): boolean {
  const hasStyleChanges: boolean =
    change.style_changes !== undefined && change.style_changes.length > 0;
  const hasTextChanges: boolean = 
    change.text_changes !== undefined && change.text_changes.length > 0;

  return hasStyleChanges || hasTextChanges;
}

/**
 * Validate encoded location format
 */
export function isValidEncodedLocation(encodedLocation: string | undefined): boolean {
  return typeof encodedLocation === "string" && encodedLocation.length > 0;
}