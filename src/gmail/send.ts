/**
 * Gmail message send (HLD §12.13, §19). Builds a compliant RFC822 message with the
 * pure `mime` builders and delivers it via `users.messages.send`. Sending is
 * non-idempotent, so the call passes `idempotent: false` and is never auto-retried —
 * a transient failure must not risk a duplicate delivery (§19). This module stays in
 * the `gmail` layer and never imports the MCP SDK (§13.2).
 *
 * Unlike drafts, `gmail_send_message` has no reply/threading input (§12.13); callers
 * who want threading should create a threaded draft (§12.10) and send it.
 */

import { type AppResult, ok } from '../util/result.js';
import { buildRfc822 } from '../mime/rfc822.js';
import { encodeBase64Url } from '../mime/base64url.js';
import type { GmailClient } from './gmailClient.js';

/** Compose input for a direct send (mirrors §12.13; `attachmentsFromLocalPaths` reserved). */
export interface SendComposeInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  /** RESERVED — must be empty in v1 (§3 #9); rejected by the RFC822 builder. */
  attachmentsFromLocalPaths?: string[];
}

/** A sent message's identifiers (§12.13 output). */
export interface SentMessage {
  id: string;
  threadId: string;
}

/** Build and send a message directly (§12.13). Non-idempotent → never retried (§19). */
export async function sendMessage(
  gmail: GmailClient,
  input: SendComposeInput,
): Promise<AppResult<SentMessage>> {
  const built = buildRfc822({
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject ?? undefined,
    bodyText: input.bodyText,
    bodyHtml: input.bodyHtml,
    attachmentsFromLocalPaths: input.attachmentsFromLocalPaths,
  });
  if (!built.ok) return built;

  const raw = encodeBase64Url(built.value);
  const sent = await gmail.execute({
    label: 'users.messages.send',
    idempotent: false,
    run: (api) =>
      api.users.messages.send({ userId: 'me', requestBody: { raw } }).then((r) => r.data),
  });
  if (!sent.ok) return sent;
  return ok({ id: sent.value.id ?? '', threadId: sent.value.threadId ?? '' });
}
