/**
 * Content hashing for attachments (HLD §15.3, §12.7). The sha256 of the raw bytes is
 * used both for the `content-addressed` collision policy (`{sha256}.{ext}`) and as the
 * `sha256` field returned by `gmail_get_attachment` (§12.7).
 */

import { createHash } from 'node:crypto';

/** Lower-case hex sha256 digest of the given bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
