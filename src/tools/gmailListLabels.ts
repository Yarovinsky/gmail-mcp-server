/**
 * `gmail_list_labels` tool (HLD §12.2, §18). Lists Gmail labels, optionally
 * filtered to system and/or user labels. There are NO pagination inputs — Gmail
 * returns the full label set (§18). Gated by `features.labels` (default true).
 */

import { z } from 'zod';
import { defineTool } from '../mcp/toolRegistry.js';
import { notAuthenticatedError, toErrorResponse } from '../mcp/errors.js';
import { REQUIRED_SCOPES } from '../auth/scopeGate.js';
import { listLabels } from '../gmail/labels.js';

export const gmailListLabelsTool = defineTool({
  name: 'gmail_list_labels',
  title: 'List Gmail labels',
  description:
    'List Gmail labels (system and/or user), each with message/thread totals and ' +
    'unread counts. Returns the full label set; Gmail does not paginate labels.',
  inputSchema: z.object({
    includeSystemLabels: z.boolean().default(true),
    includeUserLabels: z.boolean().default(true),
  }),
  feature: 'labels',
  requiredScopesAnyOf: REQUIRED_SCOPES.gmail_list_labels,
  handler: async (input, context) => {
    if (!context.session) {
      return toErrorResponse(notAuthenticatedError());
    }
    const result = await listLabels(context.session.gmail, {
      includeSystem: input.includeSystemLabels,
      includeUser: input.includeUserLabels,
    });
    if (!result.ok) {
      return toErrorResponse(result.error);
    }
    return { ok: true, labels: result.value };
  },
});
