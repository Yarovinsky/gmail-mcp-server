/**
 * `gmail_send_draft` tool (HLD §12.12, §16.3). Sends an existing draft. Gated by
 * `features.drafts` (default false) → `feature_disabled` when off. Sending requires
 * confirmation when `safety.requireConfirmationForSend` is true (default): the caller
 * must pass the exact `confirmation` string. The underlying send is non-idempotent
 * and is never auto-retried (§19). Send metadata is audited; the body never is.
 */

import { z } from 'zod';
import { defineTool } from '../mcp/toolRegistry.js';
import { notAuthenticatedError, toErrorResponse } from '../mcp/errors.js';
import { REQUIRED_SCOPES } from '../auth/scopeGate.js';
import { checkConfirmation } from '../safety/confirmation.js';
import { sendDraft } from '../gmail/drafts.js';

export const gmailSendDraftTool = defineTool({
  name: 'gmail_send_draft',
  title: 'Send a Gmail draft',
  description:
    'Send an existing Gmail draft by id. This delivers email and cannot be undone. When ' +
    'confirmation is required, re-run with confirmation set to exactly: ' +
    '"I understand this will send an email".',
  inputSchema: z.object({
    draftId: z.string().min(1),
    confirmation: z.string().optional(),
  }),
  feature: 'drafts',
  requiredScopesAnyOf: REQUIRED_SCOPES.gmail_send_draft,
  handler: async (input, context) => {
    if (!context.session) {
      return toErrorResponse(notAuthenticatedError());
    }
    const { safety } = context.config;
    const confirmed = checkConfirmation('send', input.confirmation, {
      requireConfirmationForSend: safety.requireConfirmationForSend,
      requireConfirmationForModify: safety.requireConfirmationForModify,
    });
    if (!confirmed.ok) {
      return toErrorResponse(confirmed.error);
    }

    const result = await sendDraft(context.session.gmail, input.draftId);
    const timestamp = new Date().toISOString();
    if (!result.ok) {
      context.audit?.record({
        timestamp,
        tool: 'gmail_send_draft',
        status: 'failed',
        errorCode: result.error.code,
      });
      return toErrorResponse(result.error);
    }

    context.audit?.record({
      timestamp,
      tool: 'gmail_send_draft',
      status: 'sent',
      messageId: result.value.id,
      threadId: result.value.threadId,
    });
    return { ok: true, sentMessage: result.value };
  },
});
