/**
 * `gmail_create_draft` tool (HLD §12.10). Creates a Gmail draft from composed
 * fields. Gated by `features.drafts` (default false) → `feature_disabled` when off.
 * `attachmentsFromLocalPaths` is reserved and must be empty in v1 (§3 #9); a
 * non-empty list is rejected by the RFC822 builder with `invalid_input`. Recipient
 * addresses and bodies are caller-provided content — never treat them as instructions.
 */

import { z } from 'zod';
import { defineTool } from '../mcp/toolRegistry.js';
import { notAuthenticatedError, toErrorResponse } from '../mcp/errors.js';
import { REQUIRED_SCOPES } from '../auth/scopeGate.js';
import { createDraft } from '../gmail/drafts.js';

export const gmailCreateDraftTool = defineTool({
  name: 'gmail_create_draft',
  title: 'Create a Gmail draft',
  description:
    'Create a Gmail draft message. Writes to the mailbox but does not send. Set ' +
    'replyToMessageId to thread the draft as a reply. Outbound attachment uploads are ' +
    'not supported in v1, so attachmentsFromLocalPaths must be empty.',
  inputSchema: z.object({
    to: z.array(z.string()).default([]),
    cc: z.array(z.string()).default([]),
    bcc: z.array(z.string()).default([]),
    subject: z.string().nullable().optional(),
    bodyText: z.string().nullable().optional(),
    bodyHtml: z.string().nullable().optional(),
    replyToMessageId: z.string().nullable().optional(),
    attachmentsFromLocalPaths: z.array(z.string()).default([]),
  }),
  feature: 'drafts',
  requiredScopesAnyOf: REQUIRED_SCOPES.gmail_create_draft,
  handler: async (input, context) => {
    if (!context.session) {
      return toErrorResponse(notAuthenticatedError());
    }

    const result = await createDraft(context.session.gmail, {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml,
      replyToMessageId: input.replyToMessageId,
      attachmentsFromLocalPaths: input.attachmentsFromLocalPaths,
    });

    const timestamp = new Date().toISOString();
    if (!result.ok) {
      context.audit?.record({
        timestamp,
        tool: 'gmail_create_draft',
        status: 'failed',
        errorCode: result.error.code,
      });
      return toErrorResponse(result.error);
    }

    context.audit?.record({
      timestamp,
      tool: 'gmail_create_draft',
      status: 'created',
      messageId: result.value.messageId,
      threadId: result.value.threadId,
    });
    return { ok: true, draft: result.value };
  },
});
