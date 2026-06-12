/**
 * Response-size bounding and per-message body caps (HLD §11.1, §12.4, §22.1 #18–#19).
 *
 * Two independent limits apply to read responses:
 *  - {@link boundToolResponse}: the TOTAL serialized response is bounded by
 *    `toolResponseBodyCharLimit`; an over-limit response is replaced by a truncated
 *    envelope flagged `truncated: true` and is never silently cut (§22.1 #18).
 *  - {@link resolveBodyCharLimit} / {@link capMessageBody}: a per-message body is
 *    bounded by the per-call `maxBodyCharsPerMessage`, itself capped at the config
 *    `maxMessageBodyChars`; truncation sets `body.truncated = true` (§12.4, §22.1 #19).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface BoundedResponse {
  /** The (possibly truncated) result object. */
  result: Record<string, unknown>;
  /** `JSON.stringify(result)` — guaranteed `<= limit` when truncated. */
  serialized: string;
  /** True when the original exceeded the limit and was replaced. */
  truncated: boolean;
}

/**
 * Bound a tool result's serialized size to `limit` characters. If it fits, the
 * result is returned unchanged. Otherwise it is replaced by a truncated envelope
 * (`{ ok, truncated: true, note, originalLength, limit, preview }`) whose own
 * serialization fits within `limit`; `preview` holds the leading portion of the
 * original JSON so nothing is silently lost.
 */
export function boundToolResponse(result: Record<string, unknown>, limit: number): BoundedResponse {
  const serialized = JSON.stringify(result) ?? 'null';
  if (serialized.length <= limit) {
    return { result, serialized, truncated: false };
  }

  const base: Record<string, unknown> = {
    ok: result.ok === false ? false : true,
    truncated: true,
    note: 'Tool response exceeded toolResponseBodyCharLimit and was truncated.',
    originalLength: serialized.length,
    limit,
  };
  if (result.ok === false && isRecord(result.error)) {
    base.error = { code: result.error.code, retryable: result.error.retryable === true };
  }

  const overhead = JSON.stringify({ ...base, preview: '' }).length;
  let budget = Math.max(0, limit - overhead);
  let envelope: Record<string, unknown> = { ...base, preview: serialized.slice(0, budget) };

  // JSON-escaping a preview can grow its encoded length; shrink until it fits.
  let guard = 0;
  while (JSON.stringify(envelope).length > limit && budget > 0 && guard < 64) {
    budget = Math.max(0, budget - (JSON.stringify(envelope).length - limit));
    envelope = { ...base, preview: serialized.slice(0, budget) };
    guard += 1;
  }
  if (JSON.stringify(envelope).length > limit) {
    // Last resort: even the skeleton + escaping overflows; drop the preview.
    delete base.preview;
    envelope = { ...base };
  }

  return { result: envelope, serialized: JSON.stringify(envelope), truncated: true };
}

/** The §12.4 message `body` object: text/html (either may be null) plus a truncation flag. */
export interface MessageBody {
  text: string | null;
  html: string | null;
  truncated: boolean;
}

/**
 * Resolve the effective per-message body character limit (§12.4, §22.1 #19): the
 * per-call `maxBodyCharsPerMessage` capped at the configured `maxMessageBodyChars`.
 * A missing or non-positive request falls back to the config maximum.
 */
export function resolveBodyCharLimit(requested: number | undefined, configMax: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return configMax;
  }
  return Math.min(Math.floor(requested), configMax);
}

/**
 * Cap a message's text/html bodies to `limit` characters, producing the §12.4
 * `body` object. Truncation is FLAGGED (`truncated: true`), never silent (§22.1 #19);
 * `null`/absent inputs are preserved as `null` (e.g. the unrequested body format).
 */
export function capMessageBody(
  input: { text?: string | null; html?: string | null },
  limit: number,
): MessageBody {
  let truncated = false;
  const cap = (value: string | null | undefined): string | null => {
    if (value === null || value === undefined) return null;
    if (value.length > limit) {
      truncated = true;
      return value.slice(0, limit);
    }
    return value;
  };
  return { text: cap(input.text), html: cap(input.html), truncated };
}
