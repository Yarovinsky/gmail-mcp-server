/**
 * Response-size bounding (HLD §11.1, §22.1 #18). The total serialized size of any
 * tool response is bounded by `toolResponseBodyCharLimit`; an over-limit response
 * is replaced by a truncated envelope flagged `truncated: true` and is never
 * silently cut. (Per-message body caps are added in Step 4.4.)
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
