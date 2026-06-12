/**
 * Filename policy for saved attachments (HLD section 15.2). Produces a safe local
 * filename from an attachment descriptor:
 *
 *  1. Preserve the original name when `preserveOriginalFilenames` is true and the
 *     original is present; otherwise generate `gmail-attachment-{messageId}-{partId}`.
 *  2. Sanitize control characters, path separators, and reserved filesystem names.
 *  3. Trim the base name to a safe length (~180 chars) while preserving the extension.
 *  4. Detect a blocked extension (reported via `blocked`).
 *  5. Warn — never auto-fail — when the extension disagrees with the declared MIME
 *     type (section 15.2 #7), suppressing the warning when the extension is blocked.
 *
 * This module decides only the *name* and reports a `blocked` flag. The actual
 * save/refuse decision (file_blocked, MIME allowlist, size cap) belongs to the
 * download policy, which is implemented separately.
 */

import path from 'node:path';
import sanitize from 'sanitize-filename';
import mime from 'mime-types';

/** Maximum length of the base name (before the extension), per section 15.2 #4. */
export const MAX_BASE_LENGTH = 180;

/** Declared types that carry no useful signal for an extension/MIME comparison. */
const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

export interface FilenamePolicyInput {
  /** Original attachment filename (`descriptor.filename`); may be empty. */
  originalFilename: string;
  /** Owning message id, used in the generated fallback name. */
  messageId: string;
  /** MIME part id, used in the generated fallback name. */
  partId?: string | undefined;
  /** Declared MIME type of the part. */
  mimeType: string;
  /** `downloads.preserveOriginalFilenames`. */
  preserveOriginal: boolean;
  /** `downloads.blockedExtensions` (each with a leading dot, e.g. `.exe`). */
  blockedExtensions: string[];
}

export interface FilenamePolicyResult {
  /** Final, sanitized, length-bounded filename (basename only — no directory). */
  filename: string;
  /** Lower-cased extension including the dot (e.g. `.pdf`), or `''` when none. */
  extension: string;
  /** True when the name was generated rather than taken from the original. */
  generated: boolean;
  /** True when `extension` is listed in `blockedExtensions`. */
  blocked: boolean;
  /** Non-fatal warnings (e.g. an extension/MIME mismatch). */
  warnings: string[];
}

/** Canonical extension (with dot, lower-cased) for a MIME type, or '' when unknown. */
function extensionForMime(mimeType: string): string {
  const ext = mime.extension(mimeType);
  return ext ? `.${ext.toLowerCase()}` : '';
}

/** Build the generated fallback name `gmail-attachment-{messageId}-{partId}{ext}`. */
function generatedName(messageId: string, partId: string | undefined, mimeType: string): string {
  const safeMessageId = messageId.trim().length > 0 ? messageId.trim() : 'unknown';
  const safePartId = partId && partId.trim().length > 0 ? partId.trim() : 'unknown';
  return `gmail-attachment-${safeMessageId}-${safePartId}${extensionForMime(mimeType)}`;
}

/** Split a name into its base and extension (the extension includes the leading dot). */
function splitExtension(name: string): { base: string; ext: string } {
  const ext = path.extname(name);
  if (ext.length === 0) return { base: name, ext: '' };
  return { base: name.slice(0, name.length - ext.length), ext };
}

/**
 * Sanitize a candidate filename and bound its length. The extension is split off the
 * raw name *before* sanitizing so a very long base cannot push the extension past
 * `sanitize-filename`'s internal 255-byte cap and lose it. The base is then trimmed to
 * `MAX_BASE_LENGTH`; leading dots are dropped so the result can never become a dotfile
 * or a `.`/`..` traversal token.
 */
function buildSafeName(candidate: string): { filename: string; extension: string } {
  const { base: rawBase, ext: rawExt } = splitExtension(candidate);

  const safeBase = sanitize(rawBase, { replacement: '_' })
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .trim();

  const rawExtInner = rawExt.startsWith('.') ? rawExt.slice(1) : rawExt;
  const safeExtInner = sanitize(rawExtInner, { replacement: '_' }).trim();
  const safeExt = safeExtInner.length > 0 ? `.${safeExtInner}` : '';

  const trimmedBase =
    safeBase.length > MAX_BASE_LENGTH ? safeBase.slice(0, MAX_BASE_LENGTH) : safeBase;

  const filename = `${trimmedBase}${safeExt}`;
  return { filename, extension: safeExt.toLowerCase() };
}

/** The base name of `filename` with its (already-computed) `extension` removed. */
function baseOf(filename: string, extension: string): string {
  return extension.length > 0 ? filename.slice(0, filename.length - extension.length) : filename;
}

/**
 * Whether the base name retains anything meaningful, i.e. at least one character that
 * is not a replacement underscore, dot, or space. Reserved tokens like `..` or `CON`
 * collapse to just `_`, which is technically valid but carries no signal — those fall
 * back to a generated name.
 */
function hasSubstance(base: string): boolean {
  return /[^_.\s]/.test(base);
}

/**
 * Resolve the safe local filename for an attachment under the configured download
 * policy (section 15.2). Never throws.
 */
export function resolveFilename(input: FilenamePolicyInput): FilenamePolicyResult {
  const warnings: string[] = [];
  const original = input.originalFilename.trim();

  let generated = false;
  let built: { filename: string; extension: string };

  if (input.preserveOriginal && original.length > 0) {
    built = buildSafeName(original);
    if (!hasSubstance(baseOf(built.filename, built.extension))) {
      // Nothing meaningful survived sanitizing (e.g. "..", "CON") — generate instead.
      generated = true;
      built = buildSafeName(generatedName(input.messageId, input.partId, input.mimeType));
    }
  } else {
    generated = true;
    built = buildSafeName(generatedName(input.messageId, input.partId, input.mimeType));
  }

  let { filename, extension } = built;
  if (filename.length === 0) {
    // Extremely defensive: even the generated name produced nothing usable.
    filename = 'gmail-attachment';
    extension = '';
  }

  // Blocked-extension policy (section 15.2 #6).
  const blockedSet = new Set(input.blockedExtensions.map((e) => e.toLowerCase()));
  const blocked = extension.length > 0 && blockedSet.has(extension);

  // Extension/MIME mismatch warning (section 15.2 #7): never auto-fail. Suppressed when
  // the extension is blocked (it will be refused anyway) and when the declared type is
  // the generic octet-stream fallback (no meaningful signal to compare against).
  if (!blocked && extension.length > 0) {
    const declared = input.mimeType.toLowerCase();
    if (!GENERIC_MIME_TYPES.has(declared)) {
      const impliedType = mime.lookup(filename);
      if (impliedType && impliedType.toLowerCase() !== declared) {
        warnings.push(
          `Attachment extension "${extension}" does not match its declared MIME type "${input.mimeType}".`,
        );
      }
    }
  }

  return { filename, extension, generated, blocked, warnings };
}
