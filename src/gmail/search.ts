/**
 * Gmail message search (HLD §12.3, §18). Runs `users.messages.list` with Gmail
 * query syntax and shapes results per the search `format` (id | summary | metadata).
 * It NEVER returns a message body — only ids, labels, snippet, attachment presence,
 * and a reduced header set. `summary`/`metadata` need per-message metadata, fetched
 * via `users.messages.get` with `format: 'metadata'` and a restricted header list.
 *
 * Uses the pure `mime` helpers (header parsing, attachment detection) the same way
 * it uses other shared utilities; it does not import the MCP SDK (§13.2).
 */

import { type AppResult, ok } from '../util/result.js';
import { internalDateToIso } from '../util/date.js';
import { parseHeaders } from '../mime/headers.js';
import { parseMessage, type MessagePart } from '../mime/parseMessage.js';
import type { GmailClient } from './gmailClient.js';

export type SearchFormat = 'id' | 'summary' | 'metadata';

export interface SearchMessageId {
  id: string;
  threadId: string;
}

export interface SummaryHeaders {
  from: string | null;
  subject: string | null;
  date: string | null;
}

export interface MetadataHeaders {
  from: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
}

interface SearchCommon extends SearchMessageId {
  labelIds: string[];
  internalDate: string | null;
  snippet: string;
  hasAttachments: boolean;
}

export interface SearchMessageSummary extends SearchCommon {
  headers: SummaryHeaders;
}

export interface SearchMessageMetadata extends SearchCommon {
  headers: MetadataHeaders;
}

export type SearchMessage = SearchMessageId | SearchMessageSummary | SearchMessageMetadata;

export interface SearchInput {
  query?: string | undefined;
  labelIds?: string[] | undefined;
  includeSpamTrash?: boolean | undefined;
  /** Already clamped to [1, maxPageSize] by the caller. */
  maxResults: number;
  pageToken?: string | undefined;
  format: SearchFormat;
}

export interface SearchResult {
  messages: SearchMessage[];
  nextPageToken?: string;
}

/** Search messages and shape the result per `format` (never returns a body, §12.3). */
export async function searchMessages(
  gmail: GmailClient,
  input: SearchInput,
): Promise<AppResult<SearchResult>> {
  const listed = await gmail.execute({
    label: 'users.messages.list',
    run: (api) =>
      api.users.messages
        .list({
          userId: 'me',
          q: input.query,
          labelIds: input.labelIds,
          includeSpamTrash: input.includeSpamTrash,
          maxResults: input.maxResults,
          pageToken: input.pageToken,
        })
        .then((response) => response.data),
  });
  if (!listed.ok) return listed;

  const stubs = listed.value.messages ?? [];
  const nextPageToken = listed.value.nextPageToken ?? undefined;
  const withToken = (messages: SearchMessage[]): SearchResult =>
    nextPageToken !== undefined ? { messages, nextPageToken } : { messages };

  if (input.format === 'id') {
    const messages: SearchMessage[] = stubs.map((stub) => ({
      id: stub.id ?? '',
      threadId: stub.threadId ?? '',
    }));
    return ok(withToken(messages));
  }

  const wantTo = input.format === 'metadata';
  const metadataHeaders = wantTo ? ['From', 'To', 'Subject', 'Date'] : ['From', 'Subject', 'Date'];

  const details = await Promise.all(
    stubs.map((stub) =>
      gmail.execute({
        label: 'users.messages.get',
        run: (api) =>
          api.users.messages
            .get({ userId: 'me', id: stub.id ?? '', format: 'metadata', metadataHeaders })
            .then((response) => response.data),
      }),
    ),
  );

  const messages: SearchMessage[] = stubs.map((stub, index) => {
    const detail = details[index];
    const id = stub.id ?? '';
    const threadId = stub.threadId ?? '';
    if (!detail.ok) {
      // A failed per-message fetch still yields a usable stub rather than failing all.
      return buildMessage({ id, threadId, wantTo });
    }
    const data = detail.value;
    const headers = parseHeaders(data.payload?.headers);
    const parsed = parseMessage((data.payload ?? undefined) as MessagePart | undefined, id, {
      includeInline: false,
    });
    return buildMessage({
      id: data.id ?? id,
      threadId: data.threadId ?? threadId,
      labelIds: data.labelIds ?? [],
      internalDate: internalDateToIso(data.internalDate),
      snippet: data.snippet ?? '',
      hasAttachments: parsed.attachments.length > 0,
      from: headers.get('from') ?? null,
      to: headers.get('to') ?? null,
      subject: headers.get('subject') ?? null,
      date: headers.get('date') ?? null,
      wantTo,
    });
  });

  return ok(withToken(messages));
}

function buildMessage(fields: {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string | null;
  snippet?: string;
  hasAttachments?: boolean;
  from?: string | null;
  to?: string | null;
  subject?: string | null;
  date?: string | null;
  wantTo: boolean;
}): SearchMessageSummary | SearchMessageMetadata {
  const common: SearchCommon = {
    id: fields.id,
    threadId: fields.threadId,
    labelIds: fields.labelIds ?? [],
    internalDate: fields.internalDate ?? null,
    snippet: fields.snippet ?? '',
    hasAttachments: fields.hasAttachments ?? false,
  };
  if (fields.wantTo) {
    return {
      ...common,
      headers: {
        from: fields.from ?? null,
        to: fields.to ?? null,
        subject: fields.subject ?? null,
        date: fields.date ?? null,
      },
    };
  }
  return {
    ...common,
    headers: {
      from: fields.from ?? null,
      subject: fields.subject ?? null,
      date: fields.date ?? null,
    },
  };
}
