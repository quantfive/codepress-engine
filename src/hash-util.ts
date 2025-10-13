/**
 * Utility functions for handling CodePress hash values
 * To be used by the browser extension for decoding repository and branch info
 */

/**
 * Decodes a hashed value created by the plugin
 * @param {string} hashedValue - The hashed value to decode
 * @returns {string|null} The decoded value or null if invalid
 */
export function decodeHashedValue(hashedValue: string | null): string | null {
  if (!hashedValue) {
    return null;
  }

  try {
    const decoded = Buffer.from(hashedValue, "base64").toString();
    const key = "codepress-identifier-key";
    const reversedKey = key.split("").reverse().join("");
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

export interface RepositoryInfo {
  repository: string;
  branch: string;
}

export function extractRepositoryInfo(
  element: HTMLElement | null
): RepositoryInfo | null {
  if (!element) {
    return null;
  }

  let target: HTMLElement | null = element;
  while (target && !target.hasAttribute("codepress-github-repo-name")) {
    target = target.parentElement;

    if (!target) {
      return null;
    }
  }

  const repository = target.getAttribute("codepress-github-repo-name");
  const branch = target.getAttribute("codepress-github-branch");

  if (!repository) {
    return null;
  }

  return {
    repository,
    branch: branch || "main",
  };
}
