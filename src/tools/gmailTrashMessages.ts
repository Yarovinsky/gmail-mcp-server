/**
 * `gmail_trash_messages` tool (HLD §12.15, §16.3). Moves one or more messages to
 * Trash. Gated by `features.modify` (default false) → `feature_disabled` when off;
 * requires the `gmail.modify` or `mail.google.com` scope.
 *
 * Trash ALWAYS requires confirmation, regardless of `requireConfirmationForModify`
 * (§12.15): the caller must pass the exact `confirmation` string. Trash is recoverable;
 * permanent delete is intentionally not implemented in v1. One bad message id lands in
 * `failed` without aborting the rest.
 */

import { z } from 'zod';
import { defineTool } from '../mcp/toolRegistry.js';
import { appError, notAuthenticatedError, toErrorResponse } from '../mcp/errors.js';
import { REQUIRED_SCOPES } from '../auth/scopeGate.js';
import { checkConfirmation } from '../safety/confirmation.js';
import { trashMessages } from '../gmail/modify.js';

export const gmailTrashMessagesTool = defineTool({
  name: 'gmail_trash_messages',
  title: 'Move Gmail messages to Trash',
  description:
    'Move one or more messages to Trash (recoverable; not a permanent delete). This always ' +
    'requires confirmation set to exactly: "I understand this will move messages to Trash".',
  inputSchema: z.object({
    messageIds: z.array(z.string().min(1)),
    confirmation: z.string().optional(),
  }),
  feature: 'modify',
  requiredScopesAnyOf: REQUIRED_SCOPES.gmail_trash_messages,
  handler: async (input, context) => {
    if (!context.session) {
      return toErrorResponse(notAuthenticatedError());
    }
    if (input.messageIds.length === 0) {
      return toErrorResponse(
        appError('invalid_input', { message: 'At least one messageId is required.' }),
      );
    }

    const { safety } = context.config;
    // Trash confirmation is unconditional (§12.15); the flags are passed for completeness.
    const confirmed = checkConfirmation('trash', input.confirmation, {
      requireConfirmationForSend: safety.requireConfirmationForSend,
      requireConfirmationForModify: safety.requireConfirmationForModify,
      messageCount: input.messageIds.length,
    });
    if (!confirmed.ok) {
      return toErrorResponse(confirmed.error);
    }

    const result = await trashMessages(context.session.gmail, input.messageIds);
    if (!result.ok) {
      return toErrorResponse(result.error);
    }

    const timestamp = new Date().toISOString();
    for (const messageId of result.value.trashed) {
      context.audit?.record({
        timestamp,
        tool: 'gmail_trash_messages',
        status: 'trashed',
        messageId,
      });
    }
    for (const item of result.value.failed) {
      context.audit?.record({
        timestamp,
        tool: 'gmail_trash_messages',
        status: 'failed',
        messageId: item.messageId,
        errorCode: item.code,
      });
    }

    return { ok: true, trashed: result.value.trashed, failed: result.value.failed };
  },
});
