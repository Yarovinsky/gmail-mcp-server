/**
 * `gmail_modify_message_labels` tool (HLD §12.14, §16.3). Adds/removes labels on one
 * or more messages — the mechanism for archiving (remove `INBOX`) and read/unread
 * (toggle `UNREAD`); there are no dedicated tools for those (§9.2). Gated by
 * `features.modify` (default false) → `feature_disabled` when off; requires the
 * `gmail.modify` or `mail.google.com` scope.
 *
 * Confirmation is required when `safety.requireConfirmationForModify` (default true)
 * OR when more than one message is targeted (§12.14), even if the flag is off. One bad
 * message id lands in `failed` without aborting the rest.
 */

import { z } from 'zod';
import { defineTool } from '../mcp/toolRegistry.js';
import { appError, notAuthenticatedError, toErrorResponse } from '../mcp/errors.js';
import { REQUIRED_SCOPES } from '../auth/scopeGate.js';
import { checkConfirmation } from '../safety/confirmation.js';
import { modifyMessageLabels } from '../gmail/modify.js';

export const gmailModifyMessageLabelsTool = defineTool({
  name: 'gmail_modify_message_labels',
  title: 'Modify Gmail message labels',
  description:
    'Add and/or remove labels on one or more messages. Archive by removing "INBOX"; mark ' +
    'read/unread by toggling "UNREAD". Modifying multiple messages, or any modify when ' +
    'confirmation is required, needs confirmation set to exactly: "I understand this will ' +
    'modify message labels".',
  inputSchema: z.object({
    messageIds: z.array(z.string().min(1)),
    addLabelIds: z.array(z.string()).default([]),
    removeLabelIds: z.array(z.string()).default([]),
    confirmation: z.string().optional(),
  }),
  feature: 'modify',
  requiredScopesAnyOf: REQUIRED_SCOPES.gmail_modify_message_labels,
  handler: async (input, context) => {
    if (!context.session) {
      return toErrorResponse(notAuthenticatedError());
    }
    if (input.messageIds.length === 0) {
      return toErrorResponse(
        appError('invalid_input', { message: 'At least one messageId is required.' }),
      );
    }
    if (input.addLabelIds.length === 0 && input.removeLabelIds.length === 0) {
      return toErrorResponse(
        appError('invalid_input', {
          message: 'Provide at least one label to add or remove (addLabelIds or removeLabelIds).',
        }),
      );
    }

    const { safety } = context.config;
    const confirmed = checkConfirmation('modify', input.confirmation, {
      requireConfirmationForSend: safety.requireConfirmationForSend,
      requireConfirmationForModify: safety.requireConfirmationForModify,
      messageCount: input.messageIds.length,
    });
    if (!confirmed.ok) {
      return toErrorResponse(confirmed.error);
    }

    const result = await modifyMessageLabels(context.session.gmail, {
      messageIds: input.messageIds,
      addLabelIds: input.addLabelIds,
      removeLabelIds: input.removeLabelIds,
    });
    if (!result.ok) {
      return toErrorResponse(result.error);
    }

    const timestamp = new Date().toISOString();
    for (const messageId of result.value.modified) {
      context.audit?.record({
        timestamp,
        tool: 'gmail_modify_message_labels',
        status: 'modified',
        messageId,
      });
    }
    for (const item of result.value.failed) {
      context.audit?.record({
        timestamp,
        tool: 'gmail_modify_message_labels',
        status: 'failed',
        messageId: item.messageId,
        errorCode: item.code,
      });
    }

    return { ok: true, modified: result.value.modified, failed: result.value.failed };
  },
});
