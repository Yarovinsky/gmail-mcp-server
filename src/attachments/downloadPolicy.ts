/**
 * Download policy (HLD §12.6, §15.2, §17). Decides whether an attachment may be saved
 * under the configured `downloads`/`limits` policy and, when it may not, which §17
 * error code a save would return.
 *
 * Three independent checks, evaluated in the order §12.6 lists them:
 *   1. `file_blocked`      — the filename's extension is in `blockedExtensions`.
 *   2. `mime_type_blocked` — `allowedMimeTypes` is non-empty and the MIME type is not
 *                            listed.
 *   3. `file_too_large`    — the size exceeds `maxAttachmentBytes`.
 *
 * `evaluateDownloadPolicy` returns the advisory `{ allowed, reason }` used by
 * `gmail_list_attachments`; `downloadPolicyError` / `assertDownloadAllowed` turn a
 * blocked decision into the canonical §17 error a save returns. The module is pure
 * (no filesystem or MCP SDK) — callers pass config primitives in.
 */

import path from 'node:path';
import { type AppError, type AppResult, err, ok } from '../util/result.js';
import { appError } from '../mcp/errors.js';

/** The §17 codes a blocked save would return, used as advisory `blockedReason` (§12.6). */
export type BlockedReason = 'file_blocked' | 'mime_type_blocked' | 'file_too_large';

/** The policy inputs drawn from `downloads.*` and `limits.maxAttachmentBytes`. */
export interface DownloadPolicyConfig {
  /** `downloads.blockedExtensions` (each with a leading dot). */
  blockedExtensions: string[];
  /** `downloads.allowedMimeTypes`; an empty list means "allow any MIME type". */
  allowedMimeTypes: string[];
  /** `limits.maxAttachmentBytes`. */
  maxAttachmentBytes: number;
}

/** The attachment being evaluated. */
export interface DownloadTarget {
  /** Filename whose extension is checked (original or policy-resolved). */
  filename: string;
  mimeType: string;
  /** Size in bytes. */
  size: number;
}

export interface DownloadDecision {
  allowed: boolean;
  reason: BlockedReason | null;
}

/** Extension (with the dot, lower-cased) of a filename, or '' when there is none. */
export function extensionOf(filename: string): string {
  return path.extname(filename).toLowerCase();
}

/**
 * Evaluate the download policy for a single attachment. Returns the first failing
 * reason (extension → MIME → size, per §12.6), or `{ allowed: true, reason: null }`.
 */
export function evaluateDownloadPolicy(
  target: DownloadTarget,
  config: DownloadPolicyConfig,
): DownloadDecision {
  const extension = extensionOf(target.filename);
  const blocked = new Set(config.blockedExtensions.map((e) => e.toLowerCase()));
  if (extension.length > 0 && blocked.has(extension)) {
    return { allowed: false, reason: 'file_blocked' };
  }

  if (config.allowedMimeTypes.length > 0) {
    const allowed = new Set(config.allowedMimeTypes.map((m) => m.toLowerCase()));
    if (!allowed.has(target.mimeType.toLowerCase())) {
      return { allowed: false, reason: 'mime_type_blocked' };
    }
  }

  if (target.size > config.maxAttachmentBytes) {
    return { allowed: false, reason: 'file_too_large' };
  }

  return { allowed: true, reason: null };
}

/** Build the canonical §17 error for a blocked download reason. */
export function downloadPolicyError(
  reason: BlockedReason,
  target: DownloadTarget,
  config: DownloadPolicyConfig,
): AppError {
  switch (reason) {
    case 'file_blocked': {
      const extension = extensionOf(target.filename);
      return appError('file_blocked', {
        message: `Attachment extension "${extension}" is blocked by the download policy.`,
        details: {
          filename: target.filename,
          extension,
          blockedExtensions: config.blockedExtensions,
        },
      });
    }
    case 'mime_type_blocked':
      return appError('mime_type_blocked', {
        message: `MIME type "${target.mimeType}" is not in the configured allowlist.`,
        details: { mimeType: target.mimeType, allowedMimeTypes: config.allowedMimeTypes },
      });
    case 'file_too_large':
      return appError('file_too_large', {
        message: `Attachment size ${target.size} bytes exceeds the maximum allowed ${config.maxAttachmentBytes} bytes.`,
        details: { size: target.size, maxAttachmentBytes: config.maxAttachmentBytes },
      });
  }
}

/**
 * Assert the attachment may be downloaded, returning `ok(undefined)` or the §17 error
 * a save would surface — the save-time counterpart to `evaluateDownloadPolicy`.
 */
export function assertDownloadAllowed(
  target: DownloadTarget,
  config: DownloadPolicyConfig,
): AppResult<void> {
  const decision = evaluateDownloadPolicy(target, config);
  if (decision.allowed || decision.reason === null) {
    return ok(undefined);
  }
  return err(downloadPolicyError(decision.reason, target, config));
}
