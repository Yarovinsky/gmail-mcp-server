/**
 * Date helpers. Gmail's `internalDate` is a string of epoch milliseconds; tool
 * outputs expose it as an ISO-8601 timestamp (e.g. the §12.3/§12.4 examples).
 */

/**
 * Convert a Gmail `internalDate` (epoch-millis string or number) to an ISO-8601
 * UTC string. Returns `null` for missing or unparseable input rather than
 * throwing, so a malformed value never crashes message rendering.
 */
export function internalDateToIso(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
