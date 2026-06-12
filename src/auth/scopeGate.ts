/**
 * Runtime any-of scope checking (HLD §9.3). A tool is allowed only if (a) its
 * feature flag is on AND (b) the granted token has at least one of the tool's
 * required scopes. The feature check is the `featureGate` (mcp/toolRegistry); this
 * module owns the scope check and the authoritative per-tool scope map (§12).
 *
 * To avoid a `tools → auth → mcp → tools` cycle, this module does not import the
 * MCP tool types. `scopeGateFor` returns a structurally-typed function that is
 * assignable to `ToolGate`, and the feature+scope composition happens in the
 * tools/mcp layer via `composeGates`.
 */

import type { AppError } from '../util/result.js';
import { insufficientScopeError } from '../mcp/errors.js';
import { Scope } from './scopeProfiles.js';

/**
 * Authoritative any-of required scopes per tool, transcribed from the §12 specs.
 * Tools reference these when declaring `requiredScopesAnyOf`, so there is a single
 * source of truth.
 */
export const REQUIRED_SCOPES = {
  gmail_get_profile: [
    Scope.GmailMetadata,
    Scope.GmailReadonly,
    Scope.GmailModify,
    Scope.MailGoogleCom,
  ],
  gmail_list_labels: [
    Scope.GmailMetadata,
    Scope.GmailLabels,
    Scope.GmailReadonly,
    Scope.GmailModify,
    Scope.MailGoogleCom,
  ],
  gmail_search_messages: [
    Scope.GmailMetadata,
    Scope.GmailReadonly,
    Scope.GmailModify,
    Scope.MailGoogleCom,
  ],
  gmail_get_message: [Scope.GmailReadonly, Scope.GmailModify, Scope.MailGoogleCom],
  gmail_get_thread: [Scope.GmailReadonly, Scope.GmailModify, Scope.MailGoogleCom],
  gmail_list_attachments: [Scope.GmailReadonly, Scope.GmailModify, Scope.MailGoogleCom],
  gmail_get_attachment: [Scope.GmailReadonly, Scope.GmailModify, Scope.MailGoogleCom],
  gmail_save_attachment: [Scope.GmailReadonly, Scope.GmailModify, Scope.MailGoogleCom],
  gmail_save_attachments: [Scope.GmailReadonly, Scope.GmailModify, Scope.MailGoogleCom],
  gmail_create_draft: [Scope.GmailCompose, Scope.GmailModify, Scope.MailGoogleCom],
  gmail_list_drafts: [Scope.GmailCompose, Scope.GmailModify, Scope.MailGoogleCom],
  gmail_send_draft: [Scope.GmailCompose, Scope.GmailModify, Scope.MailGoogleCom],
  gmail_send_message: [Scope.GmailSend, Scope.MailGoogleCom],
  gmail_modify_message_labels: [Scope.GmailModify, Scope.MailGoogleCom],
  gmail_trash_messages: [Scope.GmailModify, Scope.MailGoogleCom],
  gmail_create_label: [Scope.GmailLabels, Scope.GmailModify, Scope.MailGoogleCom],
  gmail_get_history: [Scope.GmailReadonly, Scope.GmailModify, Scope.MailGoogleCom],
} as const satisfies Record<string, readonly Scope[]>;

/**
 * Check any-of scopes: returns `null` when no scope is required or the granted set
 * contains at least one required scope; otherwise an `insufficient_scope` error
 * with the §11.1 `requiredAnyOf`/`granted` details.
 */
export function checkScopes(
  requiredAnyOf: readonly string[] | undefined,
  granted: readonly string[],
): AppError | null {
  if (!requiredAnyOf || requiredAnyOf.length === 0) return null;
  const grantedSet = new Set(granted);
  if (requiredAnyOf.some((scope) => grantedSet.has(scope))) return null;
  return insufficientScopeError([...requiredAnyOf], [...granted]);
}

/**
 * Build a scope gate bound to a granted scope set. The returned function is
 * structurally compatible with `ToolGate` (it only reads `requiredScopesAnyOf`).
 */
export function scopeGateFor(
  granted: readonly string[],
): (tool: { requiredScopesAnyOf?: readonly string[] }) => AppError | null {
  return (tool) => checkScopes(tool.requiredScopesAnyOf, granted);
}
