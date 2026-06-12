/**
 * The authenticated Gmail session handed to tool handlers via `ToolContext`
 * (HLD §9, §13.2). It bundles the retrying {@link GmailClient} with the scopes the
 * stored token was granted, so tools can call Gmail and the scope gate can enforce
 * any-of scope requirements. A `null` session means the server is not authenticated;
 * tools that need the mailbox return `not_authenticated`.
 */

import type { GmailClient } from './gmailClient.js';

export interface GmailSession {
  /** The retrying Gmail API wrapper bound to the authenticated user. */
  gmail: GmailClient;
  /** OAuth scope URIs the active token was granted (for scope gating + reporting). */
  grantedScopes: string[];
}
