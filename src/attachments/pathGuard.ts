/**
 * Download-root containment guard (HLD §15.1, §12.8). Every saved attachment must
 * land strictly inside `downloads.rootDir`. The algorithm: expand `~` → resolve the
 * root to an absolute (real) path → resolve the requested RELATIVE path against it →
 * normalize → require the result is inside the root (equal, or root + separator
 * prefix). Absolute requests and post-normalization `..` escapes are rejected.
 *
 * Beyond the lexical check, the deepest existing ancestor of the target is resolved
 * via `realpath` so a symlink pointing outside the root cannot be used to escape
 * (§22.1 #12). Path comparison is case-insensitive on Windows.
 */

import fs from 'node:fs';
import path from 'node:path';
import { type AppResult, ok } from '../util/result.js';
import { errorResult } from '../mcp/errors.js';
import { expandHome } from '../config/paths.js';

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/** Resolve the real path of the deepest existing ancestor, re-appending the rest. */
function realpathExistingPrefix(target: string): string {
  let current = target;
  const tail: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break; // reached a filesystem root
    tail.unshift(path.basename(current));
    current = parent;
  }
  const realBase = realpathOrSelf(current);
  return tail.length > 0 ? path.join(realBase, ...tail) : realBase;
}

/** Lower-case for comparison on case-insensitive filesystems (Windows). */
function pathKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isInside(root: string, candidate: string): boolean {
  const rootKey = pathKey(root);
  const candidateKey = pathKey(candidate);
  if (candidateKey === rootKey) return true;
  const rootWithSep = rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep;
  return candidateKey.startsWith(rootWithSep);
}

/** Expand `~`, resolve to absolute, and resolve symlinks on the root when it exists. */
export function resolveDownloadRoot(rootDir: string): string {
  return realpathOrSelf(path.resolve(expandHome(rootDir)));
}

/**
 * Resolve a requested relative path within `rootDir`, returning the absolute target
 * path or a `path_not_allowed` error. Rejects absolute requests, `..` escapes, and
 * symlinked-ancestor escapes (§12.8, §15.1, §22.1 #12).
 */
export function resolveWithinRoot(rootDir: string, requestedRelative: string): AppResult<string> {
  const requested = requestedRelative ?? '';
  if (requested.length > 0 && path.isAbsolute(requested)) {
    return errorResult('path_not_allowed', {
      message: 'Absolute paths are not allowed; provide a path relative to the download root.',
      details: { requestedPath: requested },
    });
  }

  const root = resolveDownloadRoot(rootDir);
  const target = path.normalize(path.resolve(root, requested));

  if (!isInside(root, target)) {
    return errorResult('path_not_allowed', {
      message: 'The requested path escapes the configured download root.',
      details: { requestedPath: requested },
    });
  }

  // Symlink-aware check: resolve the existing ancestors and re-verify containment.
  const realTarget = realpathExistingPrefix(target);
  if (!isInside(root, realTarget)) {
    return errorResult('path_not_allowed', {
      message: 'The requested path resolves outside the download root via a symbolic link.',
      details: { requestedPath: requested },
    });
  }

  return ok(target);
}
