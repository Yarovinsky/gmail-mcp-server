/**
 * Gmail mailbox history (HLD §12.17, §18). Wraps `users.history.list`, returning the
 * changes since a `startHistoryId` along with the mailbox's current `historyId` and a
 * `nextPageToken` for pagination (§18). History records carry only metadata (message
 * ids, thread ids, label ids) — never bodies — so they are passed through as-is. This
 * module stays in the `gmail` layer and never imports the MCP SDK (§13.2).
 */

import { type AppResult, ok } from '../util/result.js';
import type { GmailClient } from './gmailClient.js';

/** Gmail history change types (`users.history.list` `historyTypes`). */
export type HistoryType = 'messageAdded' | 'messageDeleted' | 'labelAdded' | 'labelRemoved';

export interface GetHistoryInput {
  startHistoryId: string;
  historyTypes?: string[] | undefined;
  labelId?: string | undefined;
  /** Already clamped to [1, maxPageSize] by the caller. */
  maxResults: number;
  pageToken?: string | undefined;
}

export interface GetHistoryResult {
  /** Raw Gmail history records (metadata only — message/thread/label ids, no bodies). */
  history: unknown[];
  nextPageToken?: string;
  /** The mailbox's current history id (the high-water mark to poll from next). */
  historyId: string | null;
}

/** List mailbox changes since `startHistoryId`, paginated per §18 (§12.17). */
export async function getHistory(
  gmail: GmailClient,
  input: GetHistoryInput,
): Promise<AppResult<GetHistoryResult>> {
  const listed = await gmail.execute({
    label: 'users.history.list',
    run: (api) =>
      api.users.history
        .list({
          userId: 'me',
          startHistoryId: input.startHistoryId,
          historyTypes: input.historyTypes,
          labelId: input.labelId,
          maxResults: input.maxResults,
          pageToken: input.pageToken,
        })
        .then((response) => response.data),
  });
  if (!listed.ok) return listed;

  const history = listed.value.history ?? [];
  const nextPageToken = listed.value.nextPageToken ?? undefined;
  const historyId = listed.value.historyId ?? null;

  return ok(
    nextPageToken !== undefined ? { history, nextPageToken, historyId } : { history, historyId },
  );
}
