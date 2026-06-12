/**
 * Attachment classification and descriptor construction (HLD §14, §5.3).
 *
 * Builds the internal {@link GmailAttachmentDescriptor} for a single Gmail message
 * part. Attachment bytes are NOT decoded here: external attachments are fetched
 * later via `attachmentId`, and inline attachments carry their base64url `data` on
 * the descriptor's internal-only `dataBase64` field. Per §14, `contentId`,
 * `headers`, `source`, and `dataBase64` are internal and excluded from tool output.
 */

import { parseHeaders, parseStructuredHeader } from './headers.js';
import type { MessagePart } from './parseMessage.js';

export type Disposition = 'attachment' | 'inline' | 'unknown';

/** The parser's internal representation of an attachment (HLD §14). */
export interface GmailAttachmentDescriptor {
  messageId: string;
  partId?: string;
  attachmentId?: string;
  filename: string;
  mimeType: string;
  size: number;
  disposition?: Disposition;
  inline: boolean;
  contentId?: string;
  /** INTERNAL-ONLY (not in tool output): all part headers, original casing. */
  headers: Record<string, string>;
  /** INTERNAL-ONLY: where the bytes live. */
  source: 'external-attachment' | 'inline-body-data';
  /** INTERNAL-ONLY: inline part bytes (base64url) when source is inline-body-data. */
  dataBase64?: string;
}

/** The relevant, normalized facts about a part used to classify it. */
export interface ClassifiedPart {
  /** Lowercased MIME type (defaults to application/octet-stream). */
  mimeType: string;
  /** Filename from `part.filename`, else Content-Disposition/Content-Type params, else ''. */
  filename: string;
  disposition: Disposition;
  contentId?: string;
  /** Header record (original casing) for the descriptor. */
  headersRecord: Record<string, string>;
}

/** Normalize a part's MIME type, filename, disposition, and Content-ID (§14.1, §14.4–14.5). */
export function classifyPart(part: MessagePart): ClassifiedPart {
  const headers = parseHeaders(part.headers);
  const mimeType = (part.mimeType ?? 'application/octet-stream').toLowerCase();

  const contentDisposition = parseStructuredHeader(headers.get('content-disposition'));
  let disposition: Disposition;
  if (contentDisposition.value === 'attachment') disposition = 'attachment';
  else if (contentDisposition.value === 'inline') disposition = 'inline';
  else disposition = 'unknown';

  // Prefer the explicit part.filename; fall back to RFC 2183/2045 filename/name params.
  let filename = typeof part.filename === 'string' ? part.filename : '';
  if (filename.length === 0) {
    const contentType = parseStructuredHeader(headers.get('content-type'));
    filename = contentDisposition.params.filename ?? contentType.params.name ?? '';
  }

  // A part with a filename but no explicit Content-Disposition is conventionally an
  // attachment (§14.4); reflect that in the descriptor's disposition (matches §12.4).
  if (disposition === 'unknown' && filename.length > 0) {
    disposition = 'attachment';
  }

  const rawContentId = headers.get('content-id');
  const contentId =
    rawContentId && rawContentId.length > 0 ? rawContentId.replace(/^<|>$/g, '') : undefined;

  const classified: ClassifiedPart = {
    mimeType,
    filename,
    disposition,
    headersRecord: headers.toRecord(),
  };
  if (contentId !== undefined) classified.contentId = contentId;
  return classified;
}

/**
 * Build a {@link GmailAttachmentDescriptor} from a part already classified as an
 * attachment. `size` prefers `body.size`; for inline data with no declared size it
 * is estimated from the base64url length without decoding (avoids large allocations
 * for huge-metadata parts, §22.2 #8).
 */
export function buildAttachmentDescriptor(
  part: MessagePart,
  classified: ClassifiedPart,
  messageId: string,
): GmailAttachmentDescriptor {
  const attachmentId = part.body?.attachmentId ?? undefined;
  const data = part.body?.data ?? undefined;
  const source = attachmentId ? 'external-attachment' : 'inline-body-data';

  const declaredSize = part.body?.size;
  const size =
    typeof declaredSize === 'number' && declaredSize >= 0
      ? declaredSize
      : data
        ? Math.floor((data.length * 3) / 4)
        : 0;

  const descriptor: GmailAttachmentDescriptor = {
    messageId,
    filename: classified.filename,
    mimeType: classified.mimeType,
    size,
    disposition: classified.disposition,
    inline: classified.disposition === 'inline',
    headers: classified.headersRecord,
    source,
  };
  if (typeof part.partId === 'string' && part.partId.length > 0) descriptor.partId = part.partId;
  if (attachmentId !== undefined) descriptor.attachmentId = attachmentId;
  if (classified.contentId !== undefined) descriptor.contentId = classified.contentId;
  if (source === 'inline-body-data' && data) descriptor.dataBase64 = data;
  return descriptor;
}
