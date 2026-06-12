/**
 * Gmail profile retrieval (HLD §12.1). Wraps `users.getProfile` through the
 * retrying {@link GmailClient} and normalizes the response into a plain
 * {@link GmailProfile}. Lives in the `gmail` layer (no MCP SDK import, §13.2).
 */

import { type AppResult, ok } from '../util/result.js';
import type { GmailClient } from './gmailClient.js';

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

/** Fetch and normalize the authenticated user's Gmail profile (§12.1). */
export async function getProfile(gmail: GmailClient): Promise<AppResult<GmailProfile>> {
  const result = await gmail.execute({
    label: 'users.getProfile',
    run: (api) => api.users.getProfile({ userId: 'me' }).then((response) => response.data),
  });
  if (!result.ok) return result;

  const data = result.value;
  return ok({
    emailAddress: data.emailAddress ?? '',
    messagesTotal: typeof data.messagesTotal === 'number' ? data.messagesTotal : 0,
    threadsTotal: typeof data.threadsTotal === 'number' ? data.threadsTotal : 0,
    historyId: data.historyId ?? '',
  });
}
