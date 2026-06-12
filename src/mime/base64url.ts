/**
 * Base64url primitives for Gmail bodies/attachments (HLD §14 #8–#9, §5.3 #4).
 *
 * Gmail returns `body.data` as base64url WITHOUT padding (`-`/`_` instead of
 * `+`/`/`). Decoding must never throw on malformed input — a bad part should yield
 * a best-effort result plus a warning, not crash the whole message parse (§14.9).
 */

/** The base64url alphabet (padding stripped before this check). */
const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;

export interface DecodedBase64Url {
  /** Decoded bytes (empty buffer for empty/undecodable input). */
  bytes: Buffer;
  /** Set when the input was malformed and decoded leniently. */
  warning?: string;
}

/**
 * Decode a base64url string into bytes, tolerating padding, embedded whitespace,
 * and out-of-alphabet characters. Never throws: on malformed input it decodes
 * what it can and returns a `warning` describing the problem (§14.8–14.9).
 */
export function decodeBase64Url(data: string | null | undefined): DecodedBase64Url {
  if (typeof data !== 'string' || data.length === 0) {
    return { bytes: Buffer.alloc(0) };
  }
  // Gmail encodes without padding; tolerate stray whitespace/newlines either way.
  const compact = data.replace(/\s+/g, '');
  const unpadded = compact.replace(/=+$/g, '');

  let warning: string | undefined;
  if (!BASE64URL_ALPHABET.test(unpadded)) {
    warning = 'Input contains characters outside the base64url alphabet; decoded leniently.';
  }

  let bytes: Buffer;
  try {
    // Node's base64url decoder maps `-`/`_`, ignores padding, and silently drops
    // invalid characters rather than throwing.
    bytes = Buffer.from(compact, 'base64url');
  } catch {
    bytes = Buffer.alloc(0);
    warning = 'Failed to decode base64url input.';
  }

  return warning === undefined ? { bytes } : { bytes, warning };
}

export interface DecodedBase64UrlText {
  text: string;
  warning?: string;
}

/**
 * Decode a base64url string into text (default UTF-8). Like {@link decodeBase64Url},
 * it never throws and surfaces a warning for malformed input.
 */
export function decodeBase64UrlToString(
  data: string | null | undefined,
  encoding: BufferEncoding = 'utf8',
): DecodedBase64UrlText {
  const { bytes, warning } = decodeBase64Url(data);
  const text = bytes.toString(encoding);
  return warning === undefined ? { text } : { text, warning };
}

/** Encode bytes or a UTF-8 string as unpadded base64url (used when composing sends). */
export function encodeBase64Url(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buffer.toString('base64url');
}
