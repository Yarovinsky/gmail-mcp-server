/**
 * `gmail_create_label` tool (HLD §12.16). Creates a Gmail label. Gated by
 * `features.labelsWrite` (default false) — NOT `features.labels`, which only enables
 * read access via `gmail_list_labels` (§12.16). Requires the `gmail.labels`,
 * `gmail.modify`, or `mail.google.com` scope. v1 is create-only: there is no update or
 * delete (§9.2).
 */

import { z } from 'zod';
import { defineTool } from '../mcp/toolRegistry.js';
import { notAuthenticatedError, toErrorResponse } from '../mcp/errors.js';
import { REQUIRED_SCOPES } from '../auth/scopeGate.js';
import { createLabel } from '../gmail/labels.js';

export const gmailCreateLabelTool = defineTool({
  name: 'gmail_create_label',
  title: 'Create a Gmail label',
  description:
    'Create a new Gmail label (nested labels use "/" in the name, e.g. "Projects/Example"). ' +
    'Create-only: updating or deleting labels is not supported in v1.',
  inputSchema: z.object({
    name: z.string().min(1),
    labelListVisibility: z
      .enum(['labelShow', 'labelShowIfUnread', 'labelHide'])
      .default('labelShow'),
    messageListVisibility: z.enum(['show', 'hide']).default('show'),
  }),
  feature: 'labelsWrite',
  requiredScopesAnyOf: REQUIRED_SCOPES.gmail_create_label,
  handler: async (input, context) => {
    if (!context.session) {
      return toErrorResponse(notAuthenticatedError());
    }

    const result = await createLabel(context.session.gmail, {
      name: input.name,
      labelListVisibility: input.labelListVisibility,
      messageListVisibility: input.messageListVisibility,
    });

    const timestamp = new Date().toISOString();
    if (!result.ok) {
      context.audit?.record({
        timestamp,
        tool: 'gmail_create_label',
        status: 'failed',
        errorCode: result.error.code,
      });
      return toErrorResponse(result.error);
    }

    context.audit?.record({ timestamp, tool: 'gmail_create_label', status: 'created' });
    return { ok: true, label: result.value };
  },
});
