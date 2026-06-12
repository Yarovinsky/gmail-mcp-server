/**
 * Gmail draft operations (HLD §12.10–§12.12, §18). Wraps `users.drafts.create`,
 * `users.drafts.list`/`get`, and `users.drafts.send` behind the retrying
 * {@link GmailClient}. Composing a draft uses the pure `mime` builders (RFC822 +
 * base64url), so this module stays in the `gmail` layer and never imports the MCP
 * SDK (§13.2). Sending a draft is non-idempotent, so it is never auto-retried (§19).
 *
 * When `replyToMessageId` is set, the original message's metadata is fetched to
 * thread the draft: its `threadId` is carried onto the new message and its
 * `Message-ID`/`References` populate the `In-Reply-To`/`References` headers, with a
 * `Re:` subject defaulted from the original when none is supplied.
 */

import { type AppResult, ok } from '../util/result.js';
import { parseHeaders } from '../mime/headers.js';
import { buildRfc822 } from '../mime/rfc822.js';
import { encodeBase64Url } from '../mime/base64url.js';
import type { GmailClient } from './gmailClient.js';

/** Compose input for a draft (mirrors §12.10; `attachmentsFromLocalPaths` reserved). */
export interface DraftComposeInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  /** Original message id to reply to; threads the draft when set (§12.10). */
  replyToMessageId?: string | null;
  /** RESERVED — must be empty in v1 (§3 #9); rejected by the RFC822 builder. */
  attachmentsFromLocalPaths?: string[];
}

/** A created draft's identifiers (§12.10 output). */
export interface CreatedDraft {
  id: string;
  messageId: string;
  threadId: string;
}

/** A draft summary entry (§12.11 output). */
export interface DraftSummary {
  id: string;
  message: {
    id: string;
    threadId: string;
    headers: { to: string | null; subject: string | null };
    snippet: string;
  };
}

export interface ListDraftsInput {
  /** Already clamped to [1, maxPageSize] by the caller. */
  maxResults: number;
  pageToken?: string | undefined;
}

export interface ListDraftsResult {
  drafts: DraftSummary[];
  nextPageToken?: string;
}

/** A sent message's identifiers (§12.12 output). */
export interface SentMessage {
  id: string;
  threadId: string;
}

interface ThreadingHints {
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  subject?: string | null;
}

/** Resolve threading headers/subject from the original message being replied to. */
async function resolveThreading(
  gmail: GmailClient,
  replyToMessageId: string,
  requestedSubject: string | null | undefined,
): Promise<AppResult<ThreadingHints>> {
  const original = await gmail.execute({
    label: 'users.messages.get',
    run: (api) =>
      api.users.messages
        .get({
          userId: 'me',
          id: replyToMessageId,
          format: 'metadata',
          metadataHeaders: ['Message-ID', 'References', 'Subject'],
        })
        .then((response) => response.data),
  });
  if (!original.ok) return original;

  const data = original.value;
  const headers = parseHeaders(data.payload?.headers);
  const messageId = headers.get('message-id');
  const priorRefs = headers.get('references');

  const hints: ThreadingHints = {};
  if (data.threadId) hints.threadId = data.threadId;
  if (messageId) {
    hints.inReplyTo = messageId;
    hints.references = priorRefs ? `${priorRefs} ${messageId}` : messageId;
  }
  // Default a `Re:` subject from the original when the caller supplied none.
  if (requestedSubject === undefined || requestedSubject === null || requestedSubject === '') {
    const originalSubject = headers.get('subject') ?? '';
    hints.subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
  } else {
    hints.subject = requestedSubject;
  }
  return ok(hints);
}

/** Create a Gmail draft from composed fields, threading it when replying (§12.10). */
export async function createDraft(
  gmail: GmailClient,
  input: DraftComposeInput,
): Promise<AppResult<CreatedDraft>> {
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let subject: string | null | undefined = input.subject;

  if (input.replyToMessageId) {
    const threading = await resolveThreading(gmail, input.replyToMessageId, input.subject);
    if (!threading.ok) return threading;
    threadId = threading.value.threadId;
    inReplyTo = threading.value.inReplyTo;
    references = threading.value.references;
    subject = threading.value.subject;
  }

  const built = buildRfc822({
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: subject ?? undefined,
    bodyText: input.bodyText,
    bodyHtml: input.bodyHtml,
    inReplyTo,
    references,
    attachmentsFromLocalPaths: input.attachmentsFromLocalPaths,
  });
  if (!built.ok) return built;

  const message: { raw: string; threadId?: string } = { raw: encodeBase64Url(built.value) };
  if (threadId) message.threadId = threadId;

  const created = await gmail.execute({
    label: 'users.drafts.create',
    run: (api) =>
      api.users.drafts.create({ userId: 'me', requestBody: { message } }).then((r) => r.data),
  });
  if (!created.ok) return created;

  const draft = created.value;
  return ok({
    id: draft.id ?? '',
    messageId: draft.message?.id ?? '',
    threadId: draft.message?.threadId ?? '',
  });
}

/** List draft summaries with per-draft headers/snippet, paginated per §18 (§12.11). */
export async function listDrafts(
  gmail: GmailClient,
  input: ListDraftsInput,
): Promise<AppResult<ListDraftsResult>> {
  const listed = await gmail.execute({
    label: 'users.drafts.list',
    run: (api) =>
      api.users.drafts
        .list({ userId: 'me', maxResults: input.maxResults, pageToken: input.pageToken })
        .then((response) => response.data),
  });
  if (!listed.ok) return listed;

  const stubs = listed.value.drafts ?? [];
  const nextPageToken = listed.value.nextPageToken ?? undefined;

  // drafts.list returns only ids; fetch each draft's metadata for headers + snippet.
  const details = await Promise.all(
    stubs.map((stub) =>
      gmail.execute({
        label: 'users.drafts.get',
        run: (api) =>
          // `users.drafts.get` (unlike messages.get) takes no `metadataHeaders`;
          // `format: 'metadata'` returns the headers without the body, which is all
          // the summary needs (§12.11).
          api.users.drafts
            .get({ userId: 'me', id: stub.id ?? '', format: 'metadata' })
            .then((response) => response.data),
      }),
    ),
  );

  const drafts: DraftSummary[] = stubs.map((stub, index) => {
    const detail = details[index];
    const id = stub.id ?? '';
    if (!detail.ok) {
      // A failed per-draft fetch still yields a usable stub rather than failing all.
      return {
        id,
        message: {
          id: stub.message?.id ?? '',
          threadId: stub.message?.threadId ?? '',
          headers: { to: null, subject: null },
          snippet: '',
        },
      };
    }
    const message = detail.value.message;
    const headers = parseHeaders(message?.payload?.headers);
    return {
      id: detail.value.id ?? id,
      message: {
        id: message?.id ?? stub.message?.id ?? '',
        threadId: message?.threadId ?? stub.message?.threadId ?? '',
        headers: {
          to: headers.get('to') ?? null,
          subject: headers.get('subject') ?? null,
        },
        snippet: message?.snippet ?? '',
      },
    };
  });

  return ok(nextPageToken !== undefined ? { drafts, nextPageToken } : { drafts });
}

/** Send an existing draft (§12.12). Non-idempotent → never auto-retried (§19). */
export async function sendDraft(
  gmail: GmailClient,
  draftId: string,
): Promise<AppResult<SentMessage>> {
  const sent = await gmail.execute({
    label: 'users.drafts.send',
    idempotent: false,
    run: (api) =>
      api.users.drafts.send({ userId: 'me', requestBody: { id: draftId } }).then((r) => r.data),
  });
  if (!sent.ok) return sent;
  return ok({ id: sent.value.id ?? '', threadId: sent.value.threadId ?? '' });
}
