/**
 * Shared body-selection policy for the read tools (HLD §12.4, §12.5). Turns an
 * extracted text/html pair into the §12.4 `body` object honoring `bodyFormat` and
 * the per-message char cap, or `null` when bodies are not requested. Lives in the
 * tools layer because it composes the `safety` cap with tool-level intent.
 */

import { capMessageBody, type MessageBody } from '../safety/limits.js';

export type BodyFormat = 'text' | 'html' | 'both';

/** Whether the HTML body should be extracted/returned for a given `bodyFormat`. */
export function wantsHtml(bodyFormat: BodyFormat): boolean {
  return bodyFormat === 'html' || bodyFormat === 'both';
}

/** Whether the plain-text body should be returned for a given `bodyFormat`. */
export function wantsText(bodyFormat: BodyFormat): boolean {
  return bodyFormat === 'text' || bodyFormat === 'both';
}

/**
 * Build the §12.4 `body` object from an extracted view, or `null` when `include`
 * is false. `bodyFormat` selects which of text/html is populated and the rest is
 * `null`; both are capped to `limit` with `truncated` flagged.
 */
export function selectBody(
  view: { text: string | null; html: string | null },
  options: { include: boolean; bodyFormat: BodyFormat; limit: number },
): MessageBody | null {
  if (!options.include) return null;
  return capMessageBody(
    {
      text: wantsText(options.bodyFormat) ? view.text : null,
      html: wantsHtml(options.bodyFormat) ? view.html : null,
    },
    options.limit,
  );
}
