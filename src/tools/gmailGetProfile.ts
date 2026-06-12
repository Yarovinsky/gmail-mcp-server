/**
 * `gmail_get_profile` tool (HLD §12.1). Returns the authenticated Gmail profile
 * plus the granted scopes and enabled features. Gated by `features.profile`
 * (default true) and any of metadata/readonly/modify/`mail.google.com` scopes.
 *
 * The handler is a thin orchestration over the gmail-layer `getProfile`: it checks
 * authentication, calls Gmail, and shapes the §12.1 response envelope. No business
 * logic lives in the MCP callback (§27.1).
 */

import { z } from 'zod';
import { defineTool } from '../mcp/toolRegistry.js';
import { notAuthenticatedError, toErrorResponse } from '../mcp/errors.js';
import { REQUIRED_SCOPES } from '../auth/scopeGate.js';
import { getProfile } from '../gmail/profile.js';
import { listEnabledFeatures } from '../config/features.js';

export const gmailGetProfileTool = defineTool({
  name: 'gmail_get_profile',
  title: 'Get Gmail profile',
  description:
    'Return the authenticated Gmail profile (email address and message/thread totals) ' +
    'along with the OAuth scopes granted and the features enabled on this server. ' +
    'Returns no message content.',
  inputSchema: z.object({}),
  feature: 'profile',
  requiredScopesAnyOf: REQUIRED_SCOPES.gmail_get_profile,
  handler: async (_input, context) => {
    if (!context.session) {
      return toErrorResponse(notAuthenticatedError());
    }
    const result = await getProfile(context.session.gmail);
    if (!result.ok) {
      return toErrorResponse(result.error);
    }
    return {
      ok: true,
      profile: result.value,
      grantedScopes: context.session.grantedScopes,
      enabledFeatures: listEnabledFeatures(context.config.features),
    };
  },
});
