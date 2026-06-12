/**
 * Thread retrieval (HLD §12.5). Wraps `users.threads.get` (format `full`) through
 * the retrying client; per-message shaping reuses `parseGmailMessage` (§12.4) in the
 * tool layer. No MCP SDK import (§13.2).
 */

import type { gmail_v1 } from 'googleapis';
import type { AppResult } from '../util/result.js';
import type { GmailClient } from './gmailClient.js';

/** Fetch a full thread (all messages with payloads). */
export async function fetchThread(
  gmail: GmailClient,
  threadId: string,
): Promise<AppResult<gmail_v1.Schema$Thread>> {
  return gmail.execute({
    label: 'users.threads.get',
    run: (api) =>
      api.users.threads.get({ userId: 'me', id: threadId, format: 'full' }).then((r) => r.data),
  });
}
