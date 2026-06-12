/**
 * Composed tool gate (HLD §9.3, §11.1). A mailbox tool is available only if:
 *  1. its feature flag is enabled (else `feature_disabled`);
 *  2. the server is authenticated (else `not_authenticated`); and
 *  3. the granted token has one of its required scopes (else `insufficient_scope`).
 *
 * The order matters: a disabled feature is reported before auth state, and auth
 * state before scope sufficiency, so the most actionable error surfaces first. This
 * module lives in the tools layer, which may depend on both `mcp` (the SDK-free
 * `toolRegistry` contract) and `auth` (the scope gate).
 */

import { composeGates, featureGate, type ToolGate } from '../mcp/toolRegistry.js';
import { scopeGateFor } from '../auth/scopeGate.js';
import { notAuthenticatedError } from '../mcp/errors.js';
import type { Config } from '../config/config.js';

/** True when a tool needs the mailbox (declares any required scopes). */
function needsMailbox(tool: { requiredScopesAnyOf?: readonly string[] }): boolean {
  return Boolean(tool.requiredScopesAnyOf && tool.requiredScopesAnyOf.length > 0);
}

/**
 * Build the feature → auth → scope gate. `authenticated` reflects whether a Gmail
 * session is present; when false, any mailbox tool is blocked with
 * `not_authenticated` before scope sufficiency is considered.
 */
export function buildToolGate(
  config: Config,
  grantedScopes: readonly string[],
  authenticated: boolean,
): ToolGate {
  const authGate: ToolGate = (tool) =>
    needsMailbox(tool) && !authenticated ? notAuthenticatedError() : null;
  return composeGates(featureGate(config), authGate, scopeGateFor(grantedScopes));
}
