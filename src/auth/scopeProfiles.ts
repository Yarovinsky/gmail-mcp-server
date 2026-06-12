/**
 * Gmail OAuth scope profiles and the `Scope` enum (HLD §9.2).
 *
 * The enum values ARE the full OAuth URIs, so granted token scopes (also URIs)
 * compare by direct string equality and `REQUIRED_SCOPES` (§9.3, Step 3.2) reads
 * naturally. Short profile names map to `https://www.googleapis.com/auth/<name>`;
 * `full` is the sole exception, mapping to `https://mail.google.com/`.
 */

import { type AppResult, ok } from '../util/result.js';
import { errorResult } from '../mcp/errors.js';

/** Gmail OAuth scopes (§9.2). The value is the authoritative full OAuth URI. */
export enum Scope {
  GmailMetadata = 'https://www.googleapis.com/auth/gmail.metadata',
  GmailReadonly = 'https://www.googleapis.com/auth/gmail.readonly',
  GmailModify = 'https://www.googleapis.com/auth/gmail.modify',
  GmailCompose = 'https://www.googleapis.com/auth/gmail.compose',
  GmailSend = 'https://www.googleapis.com/auth/gmail.send',
  GmailLabels = 'https://www.googleapis.com/auth/gmail.labels',
  MailGoogleCom = 'https://mail.google.com/',
}

/** Every known scope URI. */
export const ALL_SCOPES: readonly string[] = Object.values(Scope);

/** Built-in scope profile names (§9.2). */
export type ScopeProfileName =
  | 'metadata'
  | 'readonly'
  | 'modify'
  | 'compose'
  | 'send'
  | 'labels'
  | 'full';

/** The 7 built-in scope profiles → their scope URIs (§9.2). */
export const SCOPE_PROFILES: Record<ScopeProfileName, readonly Scope[]> = {
  metadata: [Scope.GmailMetadata],
  readonly: [Scope.GmailReadonly],
  modify: [Scope.GmailModify],
  compose: [Scope.GmailCompose],
  send: [Scope.GmailSend],
  labels: [Scope.GmailLabels],
  full: [Scope.MailGoogleCom],
};

/** Ordered list of profile names (for help text / validation messages). */
export const SCOPE_PROFILE_NAMES = Object.keys(SCOPE_PROFILES) as ScopeProfileName[];

export function isScopeProfileName(name: string): name is ScopeProfileName {
  return Object.prototype.hasOwnProperty.call(SCOPE_PROFILES, name);
}

/**
 * Map a short scope name to its full OAuth URI (§9.2). `full` → `mail.google.com`;
 * any other short name → `https://www.googleapis.com/auth/<short-name>`.
 */
export function scopeUriForShortName(shortName: string): string {
  if (shortName === 'full') return Scope.MailGoogleCom;
  if (shortName === 'mail.google.com' || shortName === 'https://mail.google.com/') {
    return Scope.MailGoogleCom;
  }
  if (shortName.startsWith('https://')) return shortName;
  return `https://www.googleapis.com/auth/${shortName}`;
}

/** Expand a built-in profile name to its scope URIs, or `invalid_input` if unknown. */
export function expandScopeProfile(name: string): AppResult<string[]> {
  if (isScopeProfileName(name)) {
    return ok([...SCOPE_PROFILES[name]]);
  }
  return errorResult('invalid_input', {
    message: `Unknown scope profile "${name}". Valid profiles: ${SCOPE_PROFILE_NAMES.join(', ')}.`,
    details: { profile: name, validProfiles: SCOPE_PROFILE_NAMES },
  });
}
