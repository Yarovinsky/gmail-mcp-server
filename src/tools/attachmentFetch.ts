/**
 * Shared tool helper: resolve an attachment's descriptor and bytes for a
 * (messageId, attachmentId?/partId?) selector. Used by `gmail_save_attachment` and
 * `gmail_save_attachments`, both of which always need the bytes.
 *
 * Lives in the tools layer because it spans gmail (fetch) and attachments/mime
 * (select/decode); the lower layers stay decoupled per §13.2.
 */

import { type AppResult, err, ok } from '../util/result.js';
import { fetchMessage } from '../gmail/messages.js';
import { fetchAttachmentData } from '../gmail/attachments.js';
import { parseMessage, type MessagePart } from '../mime/parseMessage.js';
import { selectAttachment } from '../attachments/attachmentService.js';
import { decodeBase64Url } from '../mime/base64url.js';
import type { GmailClient } from '../gmail/gmailClient.js';
import type { GmailAttachmentDescriptor } from '../mime/attachmentExtractor.js';
import type { Config } from '../config/configSchema.js';
import type { SaveAttachmentPolicy } from '../attachments/saveAttachment.js';

/** Build the save policy from the effective config (`downloads.*` + `limits`). */
export function buildSavePolicy(config: Config): SaveAttachmentPolicy {
  return {
    preserveOriginalFilenames: config.downloads.preserveOriginalFilenames,
    blockedExtensions: config.downloads.blockedExtensions,
    allowedMimeTypes: config.downloads.allowedMimeTypes,
    collisionPolicy: config.downloads.collisionPolicy,
    maxAttachmentBytes: config.limits.maxAttachmentBytes,
  };
}

export interface AttachmentSelectorInput {
  messageId: string;
  attachmentId?: string | undefined;
  partId?: string | undefined;
}

export interface ResolvedAttachment {
  descriptor: GmailAttachmentDescriptor;
  bytes: Buffer;
}

/**
 * Fetch the message, select the attachment by id/part, and obtain its bytes (external
 * attachments are fetched; inline parts are decoded from the descriptor). Returns a
 * canonical §17 error on any failure (not_found, gmail errors, etc.).
 */
export async function resolveAttachmentBytes(
  gmail: GmailClient,
  selector: AttachmentSelectorInput,
): Promise<AppResult<ResolvedAttachment>> {
  const fetched = await fetchMessage(gmail, selector.messageId, 'full');
  if (!fetched.ok) return err(fetched.error);

  const parsed = parseMessage(
    (fetched.value.payload ?? undefined) as MessagePart | undefined,
    fetched.value.id ?? selector.messageId,
    { includeHtml: false, includeInline: true },
  );
  const selected = selectAttachment(parsed.attachments, {
    attachmentId: selector.attachmentId,
    partId: selector.partId,
  });
  if (!selected.ok) return err(selected.error);
  const descriptor = selected.value;

  let bytes: Buffer;
  if (descriptor.attachmentId) {
    const data = await fetchAttachmentData(gmail, selector.messageId, descriptor.attachmentId);
    if (!data.ok) return err(data.error);
    bytes = data.value.bytes;
  } else {
    bytes = decodeBase64Url(descriptor.dataBase64 ?? '').bytes;
  }

  return ok({ descriptor, bytes });
}
