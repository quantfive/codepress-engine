/**
 * @fileoverview File path encoding utilities for CodePress
 * Provides XOR-based encoding with URL-safe base64 for secure file path transmission
 */

// Default secret key for encoding - should be configurable in production
const DEFAULT_SECRET: Buffer = Buffer.from("codepress-file-obfuscation");

/**
 * Get the secret key for encoding/decoding
 * Allows configuration via environment variable or uses default
 */
function getSecret(): Buffer {
  const envSecret: string | undefined = process.env.CODEPRESS_ENCODING_SECRET;
  if (envSecret) {
    return Buffer.from(envSecret);
  }
  return DEFAULT_SECRET;
}

/**
 * Encode a file path using XOR encryption and URL-safe base64
 */
export function encode(relPath: string): string {
  if (!relPath) {
    return "";
  }

  const secret: Buffer = getSecret();
  const xored: Buffer = Buffer.from(Buffer.from(relPath).map(
    (b: number, i: number) => b ^ secret[i % secret.length]
  ));

  return xored
    .toString("base64")
    .replace(/[+/=]/g, (c: string) => ({ "+": "-", "/": "_", "=": "" })[c] || ""); // URL-safe
}

/**
 * Decode an encoded file path back to original path
 */
export function decode(encodedPath: string): string {
  if (!encodedPath) {
    return "";
  }

  const secret: Buffer = getSecret();
  const normalizedBase64: string = encodedPath.replace(
    /[-_]/g,
    (c: string) => ({ "-": "+", _: "/" })[c] || ""
  );
  const buf: Buffer = Buffer.from(normalizedBase64, "base64");

  return buf.map((b: number, i: number) => b ^ secret[i % secret.length]).toString();
}