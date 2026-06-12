/**
 * Single-attachment save composition (HLD §12.8, §15). Given the already-fetched bytes
 * and the relevant config, this composes the safety layers in order:
 *
 *   1. path guard       — resolve `targetDirectory` strictly inside `downloads.rootDir`
 *   2. filename policy   — sanitize / generate / length-bound the filename (§15.2)
 *   3. download policy   — blocked extension / MIME allowlist / size cap (§12.6, §17)
 *   4. collision policy  — append-counter / overwrite / fail / content-addressed (§15.3)
 *   5. write             — mkdir -p the directory and write the bytes
 *
 * It performs filesystem writes directly (like `pathGuard`), but takes the bytes as
 * input and never touches gmail — keeping the `attachments` layer free of gmail/MCP
 * imports per §13.2. Tools fetch the bytes (gmail) and call this.
 */

import fs from 'node:fs';
import { type AppResult, err, ok } from '../util/result.js';
import { appError } from '../mcp/errors.js';
import { resolveWithinRoot } from './pathGuard.js';
import { resolveFilename } from './filenamePolicy.js';
import { assertDownloadAllowed } from './downloadPolicy.js';
import { resolveCollision, type CollisionPolicy } from './collision.js';
import { sha256Hex } from './hash.js';

/** The §12.8 `savedAttachment` object. */
export interface SavedAttachment {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  collisionPolicyApplied: CollisionPolicy;
}

/** Outcome of a save: a written file, or a deliberately skipped duplicate (§12.9). */
export type SaveOutcome =
  | { status: 'saved'; saved: SavedAttachment }
  | { status: 'skipped'; reason: string; filename: string; path: string };

/** Effective download/collision policy for a save (drawn from `downloads`/`limits`). */
export interface SaveAttachmentPolicy {
  preserveOriginalFilenames: boolean;
  blockedExtensions: string[];
  allowedMimeTypes: string[];
  collisionPolicy: CollisionPolicy;
  maxAttachmentBytes: number;
}

export interface SaveAttachmentInput {
  /** `downloads.rootDir` (may contain `~`). */
  rootDir: string;
  /** Relative subdirectory under the root (may be empty). */
  targetDirectory: string;
  /** Attachment's original filename (from the descriptor). */
  originalFilename: string;
  /** Optional caller-supplied filename override (§12.8 `filename`). */
  requestedFilename?: string | undefined;
  messageId: string;
  partId?: string | undefined;
  mimeType: string;
  bytes: Uint8Array;
  policy: SaveAttachmentPolicy;
  /** Per-call override forcing the `overwrite` collision policy (§12.8 `overwrite`). */
  overwrite?: boolean;
}

/**
 * Save one attachment's bytes under the download root, applying the path / filename /
 * download / collision policies in order. Returns the §12.8 `savedAttachment` (or a
 * `skipped` outcome for a content-addressed duplicate), or a canonical §17 error.
 */
export function saveAttachment(input: SaveAttachmentInput): AppResult<SaveOutcome> {
  // 1. Path guard — resolve the destination directory strictly inside the root.
  const dirResult = resolveWithinRoot(input.rootDir, input.targetDirectory);
  if (!dirResult.ok) return err(dirResult.error);
  const dir = dirResult.value;

  // 2. Filename policy. A caller-supplied filename is preserved as-is (still sanitized).
  const requested = input.requestedFilename?.trim() ?? '';
  const useRequested = requested.length > 0;
  const resolved = resolveFilename({
    originalFilename: useRequested ? requested : input.originalFilename,
    messageId: input.messageId,
    partId: input.partId,
    mimeType: input.mimeType,
    preserveOriginal: useRequested ? true : input.policy.preserveOriginalFilenames,
    blockedExtensions: input.policy.blockedExtensions,
  });

  const size = input.bytes.length;

  // 3. Download policy — blocked extension / MIME allowlist / size cap.
  const allowed = assertDownloadAllowed(
    { filename: resolved.filename, mimeType: input.mimeType, size },
    {
      blockedExtensions: input.policy.blockedExtensions,
      allowedMimeTypes: input.policy.allowedMimeTypes,
      maxAttachmentBytes: input.policy.maxAttachmentBytes,
    },
  );
  if (!allowed.ok) return err(allowed.error);

  // 4. Collision policy.
  const sha256 = sha256Hex(input.bytes);
  const effectivePolicy: CollisionPolicy = input.overwrite
    ? 'overwrite'
    : input.policy.collisionPolicy;
  const action = resolveCollision({
    dir,
    filename: resolved.filename,
    policy: effectivePolicy,
    sha256,
    exists: fs.existsSync,
  });

  if (action.kind === 'fail') {
    // A `fail`-policy collision is reported as a failure (§12.9), not a skip.
    return err(
      appError('invalid_input', {
        message: action.reason,
        details: { filename: resolved.filename, reason: 'file_exists' },
      }),
    );
  }

  if (action.kind === 'skip') {
    return ok({
      status: 'skipped',
      reason: 'duplicate',
      filename: action.filename,
      path: action.path,
    });
  }

  // 5. Write — ensure the directory exists, then write the bytes.
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(action.path, input.bytes);
  } catch (cause) {
    return err(
      appError('internal_error', {
        message: `Failed to write attachment to "${action.path}".`,
        details: { cause: String(cause) },
      }),
    );
  }

  return ok({
    status: 'saved',
    saved: {
      path: action.path,
      filename: action.filename,
      mimeType: input.mimeType,
      size,
      sha256,
      collisionPolicyApplied: effectivePolicy,
    },
  });
}
