/**
 * Body text extraction from a Gmail message part (HLD §14.2–14.3).
 *
 * Decodes a `text/plain` or `text/html` leaf's base64url `body.data` to a string.
 * Decoding never throws — a malformed body yields best-effort text plus a warning
 * (§14.9). Charset transcoding is not performed: bodies are decoded as UTF-8, and a
 * non-UTF-8/ASCII declared charset is surfaced as a warning rather than failing.
 */

import { decodeBase64UrlToString } from './base64url.js';
import { parseHeaders, parseStructuredHeader } from './headers.js';
import type { MessagePart } from './parseMessage.js';

export interface DecodedTextPart {
  text: string;
  warning?: string;
}

/** Decode a text part's inline `body.data` to a UTF-8 string (never throws). */
export function decodeTextPart(part: MessagePart): DecodedTextPart {
  const { text, warning } = decodeBase64UrlToString(part.body?.data ?? '');
  return warning === undefined ? { text } : { text, warning };
}

/**
 * Return a warning when a text part declares a charset this parser does not
 * transcode (it decodes as UTF-8), or `undefined` when the charset is UTF-8/ASCII
 * or unspecified.
 */
export function charsetWarning(part: MessagePart): string | undefined {
  const contentType = parseStructuredHeader(parseHeaders(part.headers).get('content-type'));
  const charset = contentType.params.charset?.toLowerCase();
  if (
    charset === undefined ||
    charset === 'utf-8' ||
    charset === 'utf8' ||
    charset === 'us-ascii' ||
    charset === 'ascii'
  ) {
    return undefined;
  }
  return `Text part declared charset "${contentType.params.charset}"; decoded as UTF-8, which may be lossy.`;
}
