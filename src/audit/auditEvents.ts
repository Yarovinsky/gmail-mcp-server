/**
 * Audit event model (HLD §16.5, §22.1 #16). An audit record may carry ONLY the
 * allowlisted fields below. It must never include OAuth tokens, full message bodies,
 * attachment bytes, or full raw MIME. {@link toAuditRecord} is the enforcement point:
 * it projects an event onto the allowlist, so even if a caller attaches stray keys,
 * nothing outside the allowlist can ever reach the audit file.
 */

/** The §16.5-allowlisted fields permitted in an audit record. */
export interface AuditEvent {
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Tool name that produced the event. */
  tool: string;
  /** Result status, e.g. `saved` | `skipped` | `failed` | `ok`. */
  status: string;
  /** Gmail profile email, when known. */
  profileEmail?: string;
  messageId?: string;
  threadId?: string;
  subject?: string;
  /** Sender (the message `From`), when known. */
  sender?: string;
  filenames?: string[];
  /** Local destination paths, for save actions. */
  paths?: string[];
  /** Content hashes (hex), for save/get actions. */
  sha256?: string[];
  /** Total byte size involved. */
  size?: number;
  /** Canonical §17 error code, for failed actions (a code only — never a body). */
  errorCode?: string;
}

/** The exact key set permitted in a serialized audit record (§16.5). */
export const AUDIT_FIELDS = [
  'timestamp',
  'tool',
  'status',
  'profileEmail',
  'messageId',
  'threadId',
  'subject',
  'sender',
  'filenames',
  'paths',
  'sha256',
  'size',
  'errorCode',
] as const;

/**
 * Project an event onto the §16.5 allowlist: only known keys with defined values
 * survive. This is the safety boundary that guarantees tokens, bodies, bytes, and raw
 * MIME can never be written, regardless of what a caller passes in.
 */
export function toAuditRecord(event: AuditEvent): Record<string, unknown> {
  const source = event as unknown as Record<string, unknown>;
  const record: Record<string, unknown> = {};
  for (const key of AUDIT_FIELDS) {
    const value = source[key];
    if (value !== undefined) record[key] = value;
  }
  return record;
}
