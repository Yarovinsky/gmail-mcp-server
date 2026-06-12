/**
 * Attachment service helpers (HLD §12.6, §14). Pure functions over parsed attachment
 * descriptors — no gmail, no filesystem (§13.2: `attachments → mime/config/fs`).
 *
 *  - `listAttachments` shapes descriptors into the §12.6 listing, annotating each with
 *    the advisory `downloadAllowed` / `blockedReason` from the download policy.
 *  - `selectAttachment` finds a single descriptor by `attachmentId` and/or `partId`,
 *    returning a canonical `not_found` error when nothing matches.
 *
 * The save composition (filesystem) lives in `saveAttachment.ts`; tools fetch bytes
 * via the gmail layer and pass them in.
 */

import { type AppResult, err, ok } from '../util/result.js';
import { appError } from '../mcp/errors.js';
import type { Disposition, GmailAttachmentDescriptor } from '../mime/attachmentExtractor.js';
import {
  evaluateDownloadPolicy,
  type BlockedReason,
  type DownloadPolicyConfig,
} from './downloadPolicy.js';

/** A single attachment as exposed by `gmail_list_attachments` (§12.6). */
export interface AttachmentListing {
  messageId: string;
  partId?: string;
  attachmentId?: string;
  filename: string;
  mimeType: string;
  size: number;
  disposition?: Disposition;
  inline: boolean;
  /** Advisory: may this be saved under the current download policy? (§12.6) */
  downloadAllowed: boolean;
  /** Advisory: the §17 code a save would return, or `null` when allowed. */
  blockedReason: BlockedReason | null;
}

/** Shape parsed descriptors into the §12.6 listing with advisory download metadata. */
export function listAttachments(
  descriptors: GmailAttachmentDescriptor[],
  config: DownloadPolicyConfig,
): AttachmentListing[] {
  return descriptors.map((d) => {
    const decision = evaluateDownloadPolicy(
      { filename: d.filename, mimeType: d.mimeType, size: d.size },
      config,
    );
    const entry: AttachmentListing = {
      messageId: d.messageId,
      filename: d.filename,
      mimeType: d.mimeType,
      size: d.size,
      inline: d.inline,
      downloadAllowed: decision.allowed,
      blockedReason: decision.reason,
    };
    if (d.partId !== undefined) entry.partId = d.partId;
    if (d.attachmentId !== undefined) entry.attachmentId = d.attachmentId;
    if (d.disposition !== undefined) entry.disposition = d.disposition;
    return entry;
  });
}

export interface AttachmentSelector {
  attachmentId?: string | undefined;
  partId?: string | undefined;
}

/**
 * Find the single descriptor matching the given selector. When both `attachmentId`
 * and `partId` are provided, both must match; either alone is sufficient. Returns a
 * `not_found` error when no descriptor matches or no selector was given.
 */
export function selectAttachment(
  descriptors: GmailAttachmentDescriptor[],
  selector: AttachmentSelector,
): AppResult<GmailAttachmentDescriptor> {
  const { attachmentId, partId } = selector;
  if (!attachmentId && !partId) {
    return err(
      appError('invalid_input', {
        message: 'An attachmentId or partId is required to select an attachment.',
      }),
    );
  }

  const match = descriptors.find((d) => {
    const attachmentOk = attachmentId === undefined || d.attachmentId === attachmentId;
    const partOk = partId === undefined || d.partId === partId;
    return attachmentOk && partOk;
  });

  if (!match) {
    return err(
      appError('not_found', {
        message: 'No attachment matches the requested attachmentId/partId in this message.',
        details: { attachmentId: attachmentId ?? null, partId: partId ?? null },
      }),
    );
  }
  return ok(match);
}
