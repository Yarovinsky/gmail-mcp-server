/**
 * Recursive Gmail `MessagePart` tree parser (HLD §14, §5.3).
 *
 * Walks a message payload into plain-text/HTML bodies plus a flat list of
 * attachment descriptors, following the §14 rules:
 *  - plain text from `text/plain`; HTML from `text/html` ONLY when requested (§14.2–14.3);
 *  - a non-empty filename makes a part an attachment even without a disposition (§14.4);
 *  - `Content-Disposition: inline` parts are inline attachments (§14.5), included
 *    only when `includeInline` is set (§14.6);
 *  - nested `multipart/alternative|mixed|related` and `message/rfc822` are recursed (§14.7);
 *  - attachments are discovered from both `body.attachmentId` and inline `body.data` (§5.3);
 *  - malformed parts never crash the walk — problems are collected as warnings (§14.9).
 *
 * This module is dependency-free of `googleapis`: it operates on the structural
 * {@link MessagePart} shape, which Gmail's `Schema$MessagePart` satisfies.
 */

import type { RawHeader } from './headers.js';
import {
  buildAttachmentDescriptor,
  classifyPart,
  type GmailAttachmentDescriptor,
} from './attachmentExtractor.js';
import { charsetWarning, decodeTextPart } from './bodyExtractor.js';

/** A Gmail message part body (`Schema$MessagePartBody`, structural subset). */
export interface MessagePartBody {
  attachmentId?: string | null;
  size?: number | null;
  data?: string | null;
}

/** A Gmail message part (`Schema$MessagePart`, structural subset). */
export interface MessagePart {
  partId?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  headers?: RawHeader[] | null;
  body?: MessagePartBody | null;
  parts?: MessagePart[] | null;
}

export interface ParseMessageOptions {
  /** Include the HTML body in the result. Default false (§14.3). */
  includeHtml?: boolean;
  /** Include inline attachments in the attachment list. Default false (§14.6). */
  includeInline?: boolean;
  /** Maximum MIME nesting depth before bailing out with a warning. Default 50. */
  maxDepth?: number;
}

export interface ParsedMessage {
  /** Concatenated plain-text body, if any. */
  text?: string;
  /** Concatenated HTML body — present only when `includeHtml` was set. */
  html?: string;
  attachments: GmailAttachmentDescriptor[];
  warnings: string[];
}

const TEXT_PLAIN = 'text/plain';
const TEXT_HTML = 'text/html';
const MULTIPART_PREFIX = 'multipart/';
const MESSAGE_RFC822 = 'message/rfc822';

/**
 * Parse a Gmail message payload (the root `MessagePart`) into bodies + attachments.
 * `messageId` is stamped onto each attachment descriptor.
 */
export function parseMessage(
  payload: MessagePart | null | undefined,
  messageId: string,
  options: ParseMessageOptions = {},
): ParsedMessage {
  const includeHtml = options.includeHtml ?? false;
  const includeInline = options.includeInline ?? false;
  const maxDepth = options.maxDepth ?? 50;

  const textChunks: string[] = [];
  const htmlChunks: string[] = [];
  const attachments: GmailAttachmentDescriptor[] = [];
  const warnings: string[] = [];

  const pushWarning = (warning: string | undefined): void => {
    if (warning !== undefined) warnings.push(warning);
  };

  const walk = (part: MessagePart | null | undefined, depth: number): void => {
    if (!part) return;
    if (depth > maxDepth) {
      warnings.push('Maximum MIME nesting depth exceeded; some parts were not parsed.');
      return;
    }

    const mimeType = (part.mimeType ?? '').toLowerCase();
    const children = Array.isArray(part.parts) ? part.parts : [];
    const isContainer =
      children.length > 0 &&
      (mimeType.startsWith(MULTIPART_PREFIX) || mimeType === MESSAGE_RFC822 || mimeType === '');

    if (isContainer) {
      for (const child of children) walk(child, depth + 1);
      return;
    }

    const classified = classifyPart(part);
    const isTextBody = classified.mimeType === TEXT_PLAIN || classified.mimeType === TEXT_HTML;
    const hasFilename = classified.filename.length > 0;
    const hasData = Boolean(part.body?.data);
    const hasAttachmentId = Boolean(part.body?.attachmentId);

    // §14.4: a non-empty filename always denotes an attachment. Otherwise any
    // non-text leaf carrying bytes (inline data or a fetchable attachmentId) is one.
    const isAttachment = hasFilename || (!isTextBody && (hasData || hasAttachmentId));

    if (isAttachment) {
      const descriptor = buildAttachmentDescriptor(part, classified, messageId);
      // §14.6: inline attachments are excluded unless explicitly requested.
      if (descriptor.inline && !includeInline) return;
      attachments.push(descriptor);
      return;
    }

    if (classified.mimeType === TEXT_PLAIN) {
      if (!hasData && hasAttachmentId) {
        warnings.push('Plain-text body is stored as a separate attachment; not inlined.');
        return;
      }
      const { text, warning } = decodeTextPart(part);
      if (text.length > 0) textChunks.push(text);
      pushWarning(warning);
      pushWarning(charsetWarning(part));
      return;
    }

    if (classified.mimeType === TEXT_HTML) {
      // §14.3: never surface HTML unless requested, but still consume the part.
      if (!includeHtml) return;
      if (!hasData && hasAttachmentId) {
        warnings.push('HTML body is stored as a separate attachment; not inlined.');
        return;
      }
      const { text, warning } = decodeTextPart(part);
      if (text.length > 0) htmlChunks.push(text);
      pushWarning(warning);
      pushWarning(charsetWarning(part));
      return;
    }

    // Any other leaf without bytes (e.g. an empty placeholder part) is ignored.
  };

  walk(payload, 0);

  const result: ParsedMessage = { attachments, warnings };
  if (textChunks.length > 0) result.text = textChunks.join('\n');
  if (includeHtml && htmlChunks.length > 0) result.html = htmlChunks.join('\n');
  return result;
}
