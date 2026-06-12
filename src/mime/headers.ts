/**
 * Case-insensitive MIME header access (HLD §14 #1).
 *
 * Gmail delivers each `MessagePart` header as a `{ name, value }` pair. HTTP/MIME
 * header names are case-insensitive, so lookups here are too, while the original
 * casing of each name is preserved for {@link ParsedHeaders.toRecord}. The module
 * is dependency-free of `googleapis`: callers adapt Gmail's header objects to the
 * structural {@link RawHeader} shape so the MIME layer stays self-contained.
 */

/** A raw header pair as delivered by Gmail (`name`/`value` may be null/absent). */
export interface RawHeader {
  name?: string | null;
  value?: string | null;
}

/** A structured header value split into its primary value and lowercased params. */
export interface StructuredHeaderValue {
  /** The leading token, e.g. `multipart/mixed` or `attachment`. Lowercased. */
  value: string;
  /** Parameters keyed by lowercased name, with surrounding quotes removed. */
  params: Record<string, string>;
}

/** Case-insensitive view over a part's headers, preserving first-seen name casing. */
export class ParsedHeaders {
  /** Lowercased name → ordered list of values. */
  private readonly byLowerName = new Map<string, string[]>();
  /** Lowercased name → original-cased name of the first occurrence. */
  private readonly originalCase = new Map<string, string>();

  constructor(raw: ReadonlyArray<RawHeader> | undefined | null) {
    for (const header of raw ?? []) {
      const name = header?.name;
      if (typeof name !== 'string' || name.length === 0) continue;
      const value = typeof header.value === 'string' ? header.value : '';
      const key = name.toLowerCase();
      const existing = this.byLowerName.get(key);
      if (existing) {
        existing.push(value);
      } else {
        this.byLowerName.set(key, [value]);
        this.originalCase.set(key, name);
      }
    }
  }

  /** The first value for `name` (case-insensitive), or undefined if absent. */
  get(name: string): string | undefined {
    return this.byLowerName.get(name.toLowerCase())?.[0];
  }

  /** All values for `name` (case-insensitive), in order; empty array if absent. */
  getAll(name: string): string[] {
    return [...(this.byLowerName.get(name.toLowerCase()) ?? [])];
  }

  /** Whether `name` is present (case-insensitive). */
  has(name: string): boolean {
    return this.byLowerName.has(name.toLowerCase());
  }

  /**
   * A plain record of header name → first value, using the original casing of each
   * name's first occurrence. Suitable for the internal attachment descriptor's
   * `headers` field (§14).
   */
  toRecord(): Record<string, string> {
    const record: Record<string, string> = {};
    for (const [key, values] of this.byLowerName) {
      const name = this.originalCase.get(key) ?? key;
      record[name] = values[0] ?? '';
    }
    return record;
  }
}

/** Build a {@link ParsedHeaders} from raw Gmail header pairs. */
export function parseHeaders(raw: ReadonlyArray<RawHeader> | undefined | null): ParsedHeaders {
  return new ParsedHeaders(raw);
}

/**
 * Parse a structured header value of the form `value; param=x; param2="y z"`
 * (e.g. `Content-Type`, `Content-Disposition`). The primary value and param names
 * are lowercased; param values keep their original casing with quotes stripped.
 * Returns an empty value with no params for undefined/empty input.
 */
export function parseStructuredHeader(
  headerValue: string | undefined | null,
): StructuredHeaderValue {
  if (typeof headerValue !== 'string' || headerValue.trim().length === 0) {
    return { value: '', params: {} };
  }
  const segments = splitOnUnquotedSemicolons(headerValue);
  const value = (segments.shift() ?? '').trim().toLowerCase();
  const params: Record<string, string> = {};
  for (const segment of segments) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim().toLowerCase();
    if (key.length === 0) continue;
    params[key] = unquote(segment.slice(eq + 1).trim());
  }
  return { value, params };
}

/** Split a header on semicolons that are not inside a double-quoted string. */
function splitOnUnquotedSemicolons(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ';' && !inQuotes) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/** Strip a single pair of surrounding double quotes, if present. */
function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}
