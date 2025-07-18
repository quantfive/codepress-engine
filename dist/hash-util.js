"use strict";

/**
 * Utility functions for handling CodePress hash values
 * To be used by the browser extension for decoding repository and branch info
 */

/**
 * Decodes a hashed value created by the plugin
 * @param {string} hashedValue - The hashed value to decode
 * @returns {string|null} The decoded value or null if invalid
 */
function decodeHashedValue(hashedValue) {
  if (!hashedValue) return null;
  try {
    // Decode from base64
    const decoded = Buffer.from(hashedValue, 'base64').toString();

    // Use the same key from the plugin
    const key = "codepress-identifier-key";
    const reversedKey = key.split("").reverse().join("");

    // Extract the value from the pattern key:value:reversedKey
    const pattern = new RegExp(`^${key}:(.+):${reversedKey}$`);
    const match = decoded.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
    return null;
  } catch (error) {
    console.error("Error decoding hashed value:", error);
    return null;
  }
}

/**
 * Extracts repository information from a DOM element
 * @param {HTMLElement} element - The DOM element to extract info from
 * @returns {Object|null} Object with repo and branch or null if not found
 */
function extractRepositoryInfo(element) {
  if (!element) return null;

  // Find the nearest element with codepress attributes
  let target = element;
  while (target && !target.hasAttribute('codepress-github-repo-name')) {
    target = target.parentElement;

    // If we reach the root without finding it, return null
    if (!target) return null;
  }

  // Get the repository and branch values (no longer hashed)
  const repository = target.getAttribute('codepress-github-repo-name');
  const branch = target.getAttribute('codepress-github-branch');
  if (!repository) return null;
  return {
    repository,
    branch: branch || 'main'
  };
}
module.exports = {
  decodeHashedValue,
  extractRepositoryInfo
};