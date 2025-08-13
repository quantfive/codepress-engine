/**
 * @fileoverview File path encoding utilities for CodePress
 * Provides XOR-based encoding with URL-safe base64 for secure file path transmission
 */

// Default secret key for encoding - should be configurable in production
const DEFAULT_SECRET = Buffer.from("codepress-file-obfuscation");

/**
 * Get the secret key for encoding/decoding
 * Allows configuration via environment variable or uses default
 * @returns {Buffer} The secret key buffer
 */
function getSecret() {
  const envSecret = process.env.CODEPRESS_ENCODING_SECRET;
  if (envSecret) {
    return Buffer.from(envSecret);
  }
  return DEFAULT_SECRET;
}

/**
 * Encode a file path using XOR encryption and URL-safe base64
 * @param {string} relPath - The relative file path to encode
 * @returns {string} The encoded file path (URL-safe base64)
 */
function encode(relPath) {
  if (!relPath) {
    return "";
  }

  const secret = getSecret();
  const xored = Buffer.from(relPath).map(
    (b, i) => b ^ secret[i % secret.length]
  );

  return xored
    .toString("base64")
    .replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]); // URL-safe
}

/**
 * Decode an encoded file path back to original path
 * @param {string} encodedPath - The encoded file path (URL-safe base64)
 * @returns {string} The decoded file path
 */
function decode(encodedPath) {
  if (!encodedPath) {
    return "";
  }

  const secret = getSecret();
  const normalizedBase64 = encodedPath.replace(
    /[-_]/g,
    (c) => ({ "-": "+", _: "/" })[c]
  );
  const buf = Buffer.from(normalizedBase64, "base64");

  return buf.map((b, i) => b ^ secret[i % secret.length]).toString();
}

module.exports = {
  encode,
  decode,
};
