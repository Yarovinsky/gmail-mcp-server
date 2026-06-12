/**
 * Single-message retrieval + shaping (HLD §12.4). `fetchMessage` wraps
 * `users.messages.get` through the retrying client; `parseGmailMessage` turns a
 * fetched message into the §12.4 view (headers, extracted bodies, attachment
 * metadata, flat part list) using the pure `mime`/`date` helpers. Body-length
 * capping is intentionally NOT done here — that safety concern is applied by the
 * tool via `safety/limits`. No MCP SDK import (§13.2).
 */

import type { gmail_v1 } from 'googleapis';
import { type AppResult } from '../util/result.js';
import { internalDateToIso } from '../util/date.js';
import { parseHeaders, type ParsedHeaders } from '../mime/headers.js';
import { parseMessage, type MessagePart } from '../mime/parseMessage.js';
import type { GmailAttachmentDescriptor } from '../mime/attachmentExtractor.js';
import type { GmailClient } from './gmailClient.js';

/** The Gmail API `format` values this module fetches with. */
export type GmailApiFormat = 'metadata' | 'full' | 'raw';

/** The §12.4 message `format` enum (distinct from the search enum). */
export type MessageFormat = 'metadata' | 'parsed' | 'full' | 'raw';

/** The reduced §12.4 attachment view (descriptor minus internal-only fields). */
export interface AttachmentOutput {
  partId?: string;
  attachmentId?: string;
  filename: string;
  mimeType: string;
  size: number;
  disposition?: 'attachment' | 'inline' | 'unknown';
  inline: boolean;
}

/** The §12.4 headers object (key headers, null when absent). */
export interface MessageHeadersView {
  from: string | null;
  to: string | null;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  date: string | null;
  messageId: string | null;
  replyTo: string | null;
}

/** Lightweight per-part metadata for `format: "full"`. */
export interface PartMeta {
  partId: string | null;
  mimeType: string | null;
  filename: string | null;
  size: number;
}

export interface ParsedGmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: string | null;
  snippet: string;
  headers: MessageHeadersView;
  text: string | null;
  html: string | null;
  attachments: AttachmentOutput[];
  parts: PartMeta[];
  warnings: string[];
}

/** Map the tool's §12.4 `format` to the Gmail API fetch `format`. */
export function gmailApiFormat(format: MessageFormat): GmailApiFormat {
  if (format === 'metadata') return 'metadata';
  if (format === 'raw') return 'raw';
  return 'full'; // parsed + full need the complete payload to parse
}

/** Fetch a single message in the given Gmail API format. */
export async function fetchMessage(
  gmail: GmailClient,
  id: string,
  format: GmailApiFormat,
): Promise<AppResult<gmail_v1.Schema$Message>> {
  return gmail.execute({
    label: 'users.messages.get',
    run: (api) => api.users.messages.get({ userId: 'me', id, format }).then((r) => r.data),
  });
}

function buildHeaders(headers: ParsedHeaders): MessageHeadersView {
  return {
    from: headers.get('from') ?? null,
    to: headers.get('to') ?? null,
    cc: headers.get('cc') ?? null,
    bcc: headers.get('bcc') ?? null,
    subject: headers.get('subject') ?? null,
    date: headers.get('date') ?? null,
    messageId: headers.get('message-id') ?? null,
    replyTo: headers.get('reply-to') ?? null,
  };
}

/** Reduce an internal descriptor to the §12.4 attachment output subset. */
function toAttachmentOutput(descriptor: GmailAttachmentDescriptor): AttachmentOutput {
  const output: AttachmentOutput = {
    filename: descriptor.filename,
    mimeType: descriptor.mimeType,
    size: descriptor.size,
    inline: descriptor.inline,
  };
  if (descriptor.partId !== undefined) output.partId = descriptor.partId;
  if (descriptor.attachmentId !== undefined) output.attachmentId = descriptor.attachmentId;
  if (descriptor.disposition !== undefined) output.disposition = descriptor.disposition;
  return output;
}

/** Flatten the MIME tree into per-part metadata (for `format: "full"`). */
function flattenParts(payload: gmail_v1.Schema$MessagePart | null | undefined): PartMeta[] {
  const out: PartMeta[] = [];
  const walk = (part: gmail_v1.Schema$MessagePart | null | undefined): void => {
    if (!part) return;
    const filename =
      typeof part.filename === 'string' && part.filename.length > 0 ? part.filename : null;
    out.push({
      partId: part.partId ?? null,
      mimeType: part.mimeType ?? null,
      filename,
      size: typeof part.body?.size === 'number' ? part.body.size : 0,
    });
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}

/**
 * Shape a fetched Gmail message into the §12.4 view. `includeHtml`/`includeInline`
 * control HTML extraction and inline-attachment inclusion; body capping is applied
 * separately by the caller.
 */
export function parseGmailMessage(
  data: gmail_v1.Schema$Message,
  options: { includeHtml: boolean; includeInline: boolean },
): ParsedGmailMessage {
  const headers = parseHeaders(data.payload?.headers);
  const parsed = parseMessage(
    (data.payload ?? undefined) as MessagePart | undefined,
    data.id ?? '',
    {
      includeHtml: options.includeHtml,
      includeInline: options.includeInline,
    },
  );
  return {
    id: data.id ?? '',
    threadId: data.threadId ?? '',
    labelIds: data.labelIds ?? [],
    internalDate: internalDateToIso(data.internalDate),
    snippet: data.snippet ?? '',
    headers: buildHeaders(headers),
    text: parsed.text ?? null,
    html: parsed.html ?? null,
    attachments: parsed.attachments.map(toAttachmentOutput),
    parts: flattenParts(data.payload),
    warnings: parsed.warnings,
  };
}
