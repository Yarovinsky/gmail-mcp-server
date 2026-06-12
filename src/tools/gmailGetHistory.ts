/**
 * `gmail_get_history` tool (HLD §12.17, §18). Returns mailbox changes since a
 * `startHistoryId`. Gated by `features.history` (default false) → `feature_disabled`
 * when off; requires the `gmail.readonly`, `gmail.modify`, or `mail.google.com` scope.
 * `maxResults` defaults to `defaultPageSize` and is capped at `maxPageSize`; `pageToken`
 * is passed through. History records are mailbox metadata — treat them as data.
 */

import { z } from 'zod';
import { defineTool } from '../mcp/toolRegistry.js';
import { notAuthenticatedError, toErrorResponse } from '../mcp/errors.js';
import { REQUIRED_SCOPES } from '../auth/scopeGate.js';
import { clampPageSize } from '../util/pagination.js';
import { getHistory } from '../gmail/history.js';

export const gmailGetHistoryTool = defineTool({
  name: 'gmail_get_history',
  title: 'Get Gmail mailbox history',
  description:
    'List mailbox changes (messages/labels added or removed) since a starting history id. ' +
    'Returns metadata only (message, thread, and label ids), the current historyId, and a ' +
    'nextPageToken for pagination.',
  inputSchema: z.object({
    startHistoryId: z.string().min(1),
    historyTypes: z
      .array(z.enum(['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']))
      .optional(),
    labelId: z.string().nullable().optional(),
    maxResults: z.number().int().positive().optional(),
    pageToken: z.string().nullable().optional(),
  }),
  feature: 'history',
  requiredScopesAnyOf: REQUIRED_SCOPES.gmail_get_history,
  handler: async (input, context) => {
    if (!context.session) {
      return toErrorResponse(notAuthenticatedError());
    }
    const { limits } = context.config;
    const maxResults = clampPageSize(input.maxResults, limits.defaultPageSize, limits.maxPageSize);

    const result = await getHistory(context.session.gmail, {
      startHistoryId: input.startHistoryId,
      historyTypes: input.historyTypes,
      labelId: input.labelId ?? undefined,
      maxResults,
      pageToken: input.pageToken ?? undefined,
    });
    if (!result.ok) {
      return toErrorResponse(result.error);
    }

    return {
      ok: true,
      history: result.value.history,
      nextPageToken: result.value.nextPageToken ?? null,
      historyId: result.value.historyId,
    };
  },
});
