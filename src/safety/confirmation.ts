/**
 * Write-operation confirmation primitive (HLD §16.3, §12.12–§12.15).
 *
 * Destructive or outbound actions require an explicit confirmation:
 *   - `send`   — required when `requireConfirmationForSend` (default true).
 *   - `trash`  — ALWAYS required, regardless of any flag (§12.15).
 *   - `modify` — required when `requireConfirmationForModify` (default true) OR when
 *                operating on multiple messages (§12.14), even if the flag is off.
 *
 * This server exposes no MCP elicitation channel, so confirmation is satisfied through
 * each tool's `confirmation` input, which must equal the tool-specific string exactly
 * (case-sensitive). When confirmation is not required, any (or no) input proceeds.
 */

import { type AppResult, err, ok } from '../util/result.js';
import { appError } from '../mcp/errors.js';

export type ConfirmationAction = 'send' | 'trash' | 'modify';

/** The exact, case-sensitive confirmation strings per action (§12.13/§12.15). */
export const CONFIRMATION_STRINGS: Record<ConfirmationAction, string> = {
  send: 'I understand this will send an email',
  trash: 'I understand this will move messages to Trash',
  modify: 'I understand this will modify message labels',
};

export interface ConfirmationContext {
  /** `safety.requireConfirmationForSend`. */
  requireConfirmationForSend: boolean;
  /** `safety.requireConfirmationForModify`. */
  requireConfirmationForModify: boolean;
  /** Number of messages a `modify` acts on; more than one forces confirmation (§12.14). */
  messageCount?: number;
}

/** Whether the action requires confirmation under the current policy (§16.3). */
export function confirmationRequired(
  action: ConfirmationAction,
  ctx: ConfirmationContext,
): boolean {
  switch (action) {
    case 'trash':
      return true; // always (§12.15)
    case 'send':
      return ctx.requireConfirmationForSend;
    case 'modify':
      return ctx.requireConfirmationForModify || (ctx.messageCount ?? 1) > 1;
  }
}

/**
 * Check a confirmation: `ok` when the action may proceed (not required, or the exact
 * string was supplied), otherwise a `confirmation_required` error naming the exact
 * string to provide (§16.3).
 */
export function checkConfirmation(
  action: ConfirmationAction,
  provided: string | undefined,
  ctx: ConfirmationContext,
): AppResult<void> {
  if (!confirmationRequired(action, ctx)) {
    return ok(undefined);
  }
  const expected = CONFIRMATION_STRINGS[action];
  if (provided === expected) {
    return ok(undefined);
  }
  return err(
    appError('confirmation_required', {
      message: `This action requires confirmation. Re-run with confirmation set to exactly: "${expected}".`,
      details: { action, expectedConfirmation: expected },
    }),
  );
}
