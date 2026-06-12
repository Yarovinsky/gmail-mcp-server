/**
 * Attachment byte retrieval (HLD §5.1–§5.4, §12.7). Wraps
 * `users.messages.attachments.get` through the retrying {@link GmailClient} and
 * decodes the base64url payload into raw bytes. Inline attachments already carry
 * their bytes on the parsed descriptor (`dataBase64`) and do not need this call.
 *
 * Lives in the `gmail` layer (not `attachments`) so the `attachments` layer can stay
 * free of any Google/gmail import per §13.2 — tools fetch bytes here and pass them to
 * the attachment service.
 */

import { type AppResult, err, ok } from '../util/result.js';
import { decodeBase64Url } from '../mime/base64url.js';
import type { GmailClient } from './gmailClient.js';

export interface FetchedAttachment {
  /** Decoded attachment bytes. */
  bytes: Buffer;
  /** Actual decoded byte length. */
  size: number;
  /** Size declared by the Gmail API (`body.size`); may differ from `size`. */
  declaredSize: number;
  /** Non-fatal decode warnings (malformed base64url, etc.). */
  warnings: string[];
}

/**
 * Fetch and decode the bytes of an external attachment via
 * `users.messages.attachments.get`. The decode never throws; a malformed payload
 * yields a `warning` rather than an error (§14.8–14.9).
 */
export async function fetchAttachmentData(
  gmail: GmailClient,
  messageId: string,
  attachmentId: string,
): Promise<AppResult<FetchedAttachment>> {
  const res = await gmail.execute({
    label: 'users.messages.attachments.get',
    run: (api) =>
      api.users.messages.attachments
        .get({ userId: 'me', messageId, id: attachmentId })
        .then((r) => r.data),
  });
  if (!res.ok) return err(res.error);

  const decoded = decodeBase64Url(res.value.data ?? '');
  const declaredSize = typeof res.value.size === 'number' ? res.value.size : decoded.bytes.length;
  return ok({
    bytes: decoded.bytes,
    size: decoded.bytes.length,
    declaredSize,
    warnings: decoded.warning ? [decoded.warning] : [],
  });
}
