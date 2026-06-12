/**
 * `gmail_send_message` tool (HLD §12.13, §16.3, §16.5, §19). Sends a new message
 * directly. Gated by `features.send` (default false) → `feature_disabled` when off;
 * requires the `gmail.send` or `mail.google.com` scope. Sending requires confirmation
 * when `safety.requireConfirmationForSend` (default true): the caller must pass the
 * exact `confirmation` string. The send is non-idempotent and never auto-retried (§19).
 *
 * Audit: send metadata (ids, subject, status) is recorded — never the message body
 * (§12.13, §16.5). `attachmentsFromLocalPaths` is reserved and must be empty (§3 #9).
 */

import { z } from 'zod';
import { defineTool } from '../mcp/toolRegistry.js';
import { notAuthenticatedError, toErrorResponse } from '../mcp/errors.js';
import { REQUIRED_SCOPES } from '../auth/scopeGate.js';
import { checkConfirmation } from '../safety/confirmation.js';
import { sendMessage } from '../gmail/send.js';

export const gmailSendMessageTool = defineTool({
  name: 'gmail_send_message',
  title: 'Send a Gmail message',
  description:
    'Compose and send a new email directly. This delivers email and cannot be undone. ' +
    'Outbound attachment uploads are not supported in v1, so attachmentsFromLocalPaths ' +
    'must be empty. When confirmation is required, re-run with confirmation set to ' +
    'exactly: "I understand this will send an email".',
  inputSchema: z.object({
    to: z.array(z.string()).default([]),
    cc: z.array(z.string()).default([]),
    bcc: z.array(z.string()).default([]),
    subject: z.string().nullable().optional(),
    bodyText: z.string().nullable().optional(),
    bodyHtml: z.string().nullable().optional(),
    attachmentsFromLocalPaths: z.array(z.string()).default([]),
    confirmation: z.string().optional(),
  }),
  feature: 'send',
  requiredScopesAnyOf: REQUIRED_SCOPES.gmail_send_message,
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

    const result = await sendMessage(context.session.gmail, {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml,
      attachmentsFromLocalPaths: input.attachmentsFromLocalPaths,
    });

    const timestamp = new Date().toISOString();
    const subject = typeof input.subject === 'string' ? input.subject : undefined;
    if (!result.ok) {
      context.audit?.record({
        timestamp,
        tool: 'gmail_send_message',
        status: 'failed',
        subject,
        errorCode: result.error.code,
      });
      return toErrorResponse(result.error);
    }

    // §16.5: log send metadata (ids + subject) but NEVER the body.
    context.audit?.record({
      timestamp,
      tool: 'gmail_send_message',
      status: 'sent',
      messageId: result.value.id,
      threadId: result.value.threadId,
      subject,
    });
    return { ok: true, sentMessage: result.value };
  },
});
