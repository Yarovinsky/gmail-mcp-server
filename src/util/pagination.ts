/**
 * Pagination helpers (§18). List/search tools clamp a requested `maxResults`
 * into `[1, maxPageSize]`, defaulting to `defaultPageSize` when omitted, and
 * pass `pageToken` straight through to Gmail.
 */

import { clamp } from './size.js';

/**
 * Resolve an effective page size: `defaultPageSize` when `requested` is
 * undefined/null, otherwise `requested` clamped into `[1, maxPageSize]` (§18,
 * §22.1 #17). `defaultPageSize` is itself clamped to the valid range as a guard.
 */
export function clampPageSize(
  requested: number | null | undefined,
  defaultPageSize: number,
  maxPageSize: number,
): number {
  if (requested === null || requested === undefined) {
    return clamp(defaultPageSize, 1, maxPageSize);
  }
  return clamp(Math.floor(requested), 1, maxPageSize);
}
