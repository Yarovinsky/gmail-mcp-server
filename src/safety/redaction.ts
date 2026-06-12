/**
 * Token/secret redaction (HLD §16.4, §16.5).
 *
 * These are pure functions with no config or logger dependency. They are applied
 * as a defense-in-depth net so that token-shaped values can never leak into logs
 * or third-party/debug output. This is NOT a switch to enable deliberate token
 * logging, which is prohibited regardless of any config flag (§16.4 item 2).
 */

export const REDACTED = '[REDACTED]';

/**
 * Token-shaped substrings scrubbed from any string. Covers Google OAuth access
 * tokens (`ya29.…`), refresh tokens (`1//…`), OAuth client secrets (`GOCSPX-…`),
 * and JWT-shaped id tokens.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /ya29\.[A-Za-z0-9._-]+/g,
  /1\/\/[A-Za-z0-9._-]{10,}/g,
  /GOCSPX-[A-Za-z0-9._-]+/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

/**
 * Object keys whose values are always redacted wholesale (normalized to
 * lowercase with `_`/`-` removed). Deliberately excludes `pageToken`/`token` so
 * Gmail pagination tokens are not scrubbed.
 */
const SENSITIVE_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'privatekey',
  'authorization',
  'password',
  'secret',
  'apikey',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

/** Replace token-shaped substrings (and `Bearer <token>`) within a string. */
export function redactString(input: string): string {
  let out = input.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`);
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Deep-clone `value`, scrubbing secrets: values under sensitive keys become
 * `[REDACTED]`, and every string is run through {@link redactString}. Errors are
 * copied with scrubbed `message`/`stack` (preserving error-ness for serializers),
 * and circular references are handled safely.
 */
export function redactSecrets<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === 'string') {
    return redactString(value) as unknown as T;
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Error) {
    const copy = new Error(redactString(value.message));
    copy.name = value.name;
    copy.stack = value.stack ? redactString(value.stack) : undefined;
    return copy as unknown as T;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, seen)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactSecrets(val, seen);
  }
  return out as unknown as T;
}

/** True if a string contains any token-shaped substring (for tests/assertions). */
export function containsTokenShape(input: string): boolean {
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]+/i.test(input)) return true;
  return TOKEN_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  });
}
