/**
 * Gmail message mutation: label add/remove and trash (HLD §12.14, §12.15).
 *
 * Both operations act on a list of message ids and report a per-message split of
 * successes and failures, so one bad id never aborts the rest. Each call is
 * idempotent — re-applying the same label set, or re-trashing an already-trashed
 * message, is safe — so transient failures are retried by the {@link GmailClient}.
 * Archiving and read/unread are expressed as label changes here (no dedicated tools,
 * §9.2). This module stays in the `gmail` layer and never imports the MCP SDK (§13.2).
 *
 * Permanent delete is intentionally NOT implemented in v1 (§12.15): the most
 * destructive action exposed is moving a message to Trash, which is recoverable.
 */

import { type AppResult, ok } from '../util/result.js';
import type { GmailClient } from './gmailClient.js';

/** A single message that could not be mutated, with its canonical §17 error. */
export interface FailedMessage {
  messageId: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface ModifyLabelsInput {
  messageIds: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
}

export interface ModifyLabelsResult {
  modified: string[];
  failed: FailedMessage[];
}

export interface TrashResult {
  trashed: string[];
  failed: FailedMessage[];
}

/** Add and/or remove labels on each message, collecting per-message outcomes (§12.14). */
export async function modifyMessageLabels(
  gmail: GmailClient,
  input: ModifyLabelsInput,
): Promise<AppResult<ModifyLabelsResult>> {
  const addLabelIds = input.addLabelIds ?? [];
  const removeLabelIds = input.removeLabelIds ?? [];

  const outcomes = await Promise.all(
    input.messageIds.map((id) =>
      gmail.execute({
        label: 'users.messages.modify',
        run: (api) =>
          api.users.messages
            .modify({ userId: 'me', id, requestBody: { addLabelIds, removeLabelIds } })
            .then((r) => r.data),
      }),
    ),
  );

  const modified: string[] = [];
  const failed: FailedMessage[] = [];
  input.messageIds.forEach((id, index) => {
    const outcome = outcomes[index];
    if (outcome.ok) {
      modified.push(id);
    } else {
      failed.push({
        messageId: id,
        code: outcome.error.code,
        message: outcome.error.message,
        retryable: outcome.error.retryable,
      });
    }
  });

  return ok({ modified, failed });
}

/** Move each message to Trash, collecting per-message outcomes (§12.15). */
export async function trashMessages(
  gmail: GmailClient,
  messageIds: string[],
): Promise<AppResult<TrashResult>> {
  const outcomes = await Promise.all(
    messageIds.map((id) =>
      gmail.execute({
        label: 'users.messages.trash',
        run: (api) => api.users.messages.trash({ userId: 'me', id }).then((r) => r.data),
      }),
    ),
  );

  const trashed: string[] = [];
  const failed: FailedMessage[] = [];
  messageIds.forEach((id, index) => {
    const outcome = outcomes[index];
    if (outcome.ok) {
      trashed.push(id);
    } else {
      failed.push({
        messageId: id,
        code: outcome.error.code,
        message: outcome.error.message,
        retryable: outcome.error.retryable,
      });
    }
  });

  return ok({ trashed, failed });
}
