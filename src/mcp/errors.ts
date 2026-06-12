/**
 * The canonical error model (HLD §17, §11.1).
 *
 * This module owns the runtime enumeration of the 16 standard error codes and a
 * factory that produces the §17 error object (always including `retryable`). It
 * builds on the `ErrorCode`/`AppError` types from `util/result.ts`.
 *
 * IMPORTANT: this file must never import the MCP SDK. It is intentionally
 * dependency-light so that `gmail`, `auth`, `attachments`, and `tools` can all
 * create stable, typed errors without violating the §13.2 dependency direction.
 */

import { type AppError, type AppResult, type ErrorCode, err } from '../util/result.js';

/**
 * Every §17 error code mapped to `true`. Typing this as `Record<ErrorCode, true>`
 * makes it a compile-time exhaustiveness check: if a code is added to the
 * `ErrorCode` union but omitted here, this object fails to typecheck.
 */
const ERROR_CODE_PRESENCE: Record<ErrorCode, true> = {
  invalid_input: true,
  not_authenticated: true,
  insufficient_scope: true,
  feature_disabled: true,
  gmail_api_error: true,
  rate_limited: true,
  not_found: true,
  permission_denied: true,
  confirmation_required: true,
  path_not_allowed: true,
  file_blocked: true,
  file_too_large: true,
  mime_type_blocked: true,
  decode_failed: true,
  network_error: true,
  internal_error: true,
};

/** All 16 standard error codes (§17) as a runtime list, in declaration order. */
export const ERROR_CODES = Object.keys(ERROR_CODE_PRESENCE) as ErrorCode[];

/** Options accepted by the error factory. */
export interface AppErrorInit {
  message: string;
  details?: Record<string, unknown>;
  /** Overrides the per-code default retryability when provided. */
  retryable?: boolean;
}

/**
 * Default retryability by code. Most errors are terminal; only transient
 * infrastructure failures (rate limiting, network blips) default to retryable
 * (§19). Per-call code can always override via `init.retryable`.
 */
const DEFAULT_RETRYABLE: Partial<Record<ErrorCode, boolean>> = {
  rate_limited: true,
  network_error: true,
};

/** Build a canonical §17 `AppError`. `details` is omitted from the object when absent. */
export function appError(code: ErrorCode, init: AppErrorInit): AppError {
  const retryable = init.retryable ?? DEFAULT_RETRYABLE[code] ?? false;
  const error: AppError = { code, message: init.message, retryable };
  if (init.details !== undefined) {
    error.details = init.details;
  }
  return error;
}

/** Build a failed `AppResult` carrying a canonical §17 error. */
export function errorResult<T = never>(code: ErrorCode, init: AppErrorInit): AppResult<T> {
  return err<T>(appError(code, init));
}

/** Wrap an `AppError` in the §11.1 tool-response envelope. */
export function toErrorResponse(error: AppError): { ok: false; error: AppError } {
  return { ok: false, error };
}

/**
 * Build an `insufficient_scope` error matching the §11.1 example: the message
 * names the acceptable scopes and `details` carries `requiredAnyOf`/`granted`.
 */
export function insufficientScopeError(requiredAnyOf: string[], granted: string[]): AppError {
  return appError('insufficient_scope', {
    message: `Tool requires one of the following scopes: ${requiredAnyOf.join(', ')}.`,
    details: { requiredAnyOf, granted },
    retryable: false,
  });
}

/** Build a `feature_disabled` error naming the feature flag that gates the tool. */
export function featureDisabledError(feature: string, message?: string): AppError {
  return appError('feature_disabled', {
    message: message ?? `This tool is disabled because the '${feature}' feature is not enabled.`,
    details: { feature },
    retryable: false,
  });
}

/** Build a `not_authenticated` error prompting the user to run auth login. */
export function notAuthenticatedError(message?: string): AppError {
  return appError('not_authenticated', {
    message: message ?? 'Not authenticated. Run `gmail-mcp-server auth login` first.',
    retryable: false,
  });
}

/** Build a generic `internal_error` from an unknown thrown value. */
export function internalError(message: string, cause?: unknown): AppError {
  const details = cause === undefined ? undefined : { cause: String(cause) };
  return appError('internal_error', details ? { message, details } : { message });
}

/** HTTP statuses that are transient and worth retrying (§19). */
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

/** True when an HTTP status should be retried with backoff (§19). */
export function isRetryableHttpStatus(status: number | undefined): boolean {
  return status !== undefined && RETRYABLE_HTTP_STATUSES.has(status);
}

/** Network-level error codes (no HTTP response) treated as transient (§19). */
const TRANSIENT_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNABORTED',
]);

/** Map an HTTP status to the closest §17 error code. */
export function mapHttpStatusToCode(status: number | undefined): ErrorCode {
  switch (status) {
    case 400:
      return 'invalid_input';
    case 401:
      return 'not_authenticated';
    case 403:
      return 'permission_denied';
    case 404:
      return 'not_found';
    case 429:
      return 'rate_limited';
    default:
      return 'gmail_api_error';
  }
}

/** Minimal structural view of a googleapis/Gaxios error we care about. */
interface HttpLikeError {
  code?: string | number;
  message?: string;
  response?: { status?: number; data?: unknown };
}

/**
 * Convert an unknown failure thrown by the Gmail/Google client into a canonical
 * §17 `AppError`. Maps HTTP status codes (e.g. 429 → `rate_limited`, retryable)
 * and bare network errors (e.g. `ENOTFOUND` → `network_error`, retryable).
 */
export function fromGmailApiError(error: unknown): AppError {
  const e = (error ?? {}) as HttpLikeError;
  const status = typeof e.response?.status === 'number' ? e.response.status : undefined;
  const message =
    typeof e.message === 'string' && e.message.length > 0 ? e.message : 'Gmail API request failed.';

  if (status === undefined) {
    if (typeof e.code === 'string' && TRANSIENT_NETWORK_CODES.has(e.code)) {
      return appError('network_error', {
        message,
        retryable: true,
        details: { cause: e.code },
      });
    }
    return appError('internal_error', { message, retryable: false });
  }

  return appError(mapHttpStatusToCode(status), {
    message,
    retryable: isRetryableHttpStatus(status),
    details: { status },
  });
}
