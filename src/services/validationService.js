/**
 * @fileoverview Request validation service for CodePress
 * Handles validation of incoming requests and data
 */

/**
 * Validate request data based on mode
 * @param {Object} data - The request data
 * @param {boolean} isAiMode - Whether this is AI mode
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
 * Validate that changes have actual content
 * @param {Object} change - The change object to validate
 * @returns {boolean} True if the change has actual content
 */
function hasValidContent(change) {
  const hasStyleChanges =
    change.style_changes && change.style_changes.length > 0;
  const hasTextChanges = change.text_changes && change.text_changes.length > 0;

  return hasStyleChanges || hasTextChanges;
}

/**
 * Validate encoded location format
 * @param {string} encodedLocation - The encoded location string
 * @returns {boolean} True if the encoded location is valid
 */
function isValidEncodedLocation(encodedLocation) {
  return typeof encodedLocation === "string" && encodedLocation.length > 0;
}

module.exports = {
  validateRequestData,
  hasValidContent,
  isValidEncodedLocation,
};