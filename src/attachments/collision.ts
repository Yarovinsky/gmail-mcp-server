/**
 * Collision policy for saved attachments (HLD §15.3). Given a target directory, a
 * desired filename, and the configured `downloads.collisionPolicy`, decide the final
 * action: write to a path, skip (a content-addressed duplicate), or fail (the `fail`
 * policy when the file already exists).
 *
 *   - `append-counter`     : `file.pdf`, `file (1).pdf`, `file (2).pdf`, … (default)
 *   - `overwrite`          : write the target path directly — selecting this policy is
 *                            the explicit allowance required by §15.3
 *   - `fail`               : fail when the target already exists
 *   - `content-addressed`  : write `{sha256}.{ext}`; an existing hash file is the same
 *                            content, so it is skipped rather than rewritten
 *
 * The resolver is pure: existence is supplied via an injected `exists` predicate so it
 * is testable without touching the filesystem. `saveAttachment` (§5.5) passes
 * `fs.existsSync` and performs the actual write.
 */

import path from 'node:path';

export type CollisionPolicy = 'append-counter' | 'overwrite' | 'fail' | 'content-addressed';

export interface ResolveCollisionInput {
  /** Absolute directory the file will be written into. */
  dir: string;
  /** Desired filename (basename only) from the filename policy. */
  filename: string;
  policy: CollisionPolicy;
  /** Lower-case hex sha256 of the content — used by `content-addressed`. */
  sha256: string;
  /** Existence predicate (absolute path → boolean); injected for testability. */
  exists: (absolutePath: string) => boolean;
}

export type CollisionAction =
  | { kind: 'write'; path: string; filename: string }
  | { kind: 'skip'; path: string; filename: string; reason: string }
  | { kind: 'fail'; reason: string };

/** Upper bound on the `append-counter` search to avoid an unbounded loop. */
const MAX_COUNTER = 10000;

/** Split a filename into its base and extension (the extension keeps its leading dot). */
function splitExtension(filename: string): { base: string; ext: string } {
  const ext = path.extname(filename);
  if (ext.length === 0) return { base: filename, ext: '' };
  return { base: filename.slice(0, filename.length - ext.length), ext };
}

/** Resolve the write/skip/fail action for a desired filename under a collision policy. */
export function resolveCollision(input: ResolveCollisionInput): CollisionAction {
  const { dir, filename, policy, sha256, exists } = input;

  if (policy === 'content-addressed') {
    const { ext } = splitExtension(filename);
    const hashName = `${sha256}${ext.toLowerCase()}`;
    const hashPath = path.join(dir, hashName);
    if (exists(hashPath)) {
      return {
        kind: 'skip',
        path: hashPath,
        filename: hashName,
        reason: 'An identical file already exists (content-addressed duplicate).',
      };
    }
    return { kind: 'write', path: hashPath, filename: hashName };
  }

  const targetPath = path.join(dir, filename);

  if (policy === 'overwrite') {
    // Choosing the overwrite policy is the explicit allowance required by §15.3.
    return { kind: 'write', path: targetPath, filename };
  }

  if (!exists(targetPath)) {
    return { kind: 'write', path: targetPath, filename };
  }

  if (policy === 'fail') {
    return { kind: 'fail', reason: `A file named "${filename}" already exists.` };
  }

  // append-counter: find the first free "{base} (n){ext}".
  const { base, ext } = splitExtension(filename);
  for (let n = 1; n <= MAX_COUNTER; n++) {
    const candidate = `${base} (${n})${ext}`;
    const candidatePath = path.join(dir, candidate);
    if (!exists(candidatePath)) {
      return { kind: 'write', path: candidatePath, filename: candidate };
    }
  }

  return {
    kind: 'fail',
    reason: `Could not find a free filename for "${filename}" after ${MAX_COUNTER} attempts.`,
  };
}
