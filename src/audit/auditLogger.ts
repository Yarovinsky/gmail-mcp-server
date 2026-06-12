/**
 * Append-only JSONL audit logger (HLD §16.5). Each record is one line of
 * `JSON.stringify(toAuditRecord(event))` at `logging.auditLogPath`. Writes are
 * best-effort: a failure is reported to the app logger and swallowed so auditing can
 * never break a tool call. The §16.5 allowlist is enforced by {@link toAuditRecord}, so
 * tokens, bodies, attachment bytes, and raw MIME are never written.
 */

import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from '../config/paths.js';
import { type AuditEvent, toAuditRecord } from './auditEvents.js';
import type { Logger } from '../util/logger.js';

export interface AuditLogger {
  /** Append a single audit event (best-effort; never throws). */
  record(event: AuditEvent): void;
}

/** A no-op audit logger, for contexts where auditing is unavailable. */
export const noopAuditLogger: AuditLogger = { record: () => {} };

/**
 * Create a file-backed, append-only JSONL audit logger at `auditLogPath` (`~` is
 * expanded). The parent directory is created on demand. Only §16.5-allowlisted fields
 * are written; write errors are logged and swallowed.
 */
export function createFileAuditLogger(auditLogPath: string, logger?: Logger): AuditLogger {
  const resolved = path.resolve(expandHome(auditLogPath));
  return {
    record(event: AuditEvent): void {
      try {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.appendFileSync(resolved, `${JSON.stringify(toAuditRecord(event))}\n`);
      } catch (cause) {
        logger?.warn(
          { err: String(cause), auditLogPath: resolved },
          'Failed to write audit record.',
        );
      }
    },
  };
}
