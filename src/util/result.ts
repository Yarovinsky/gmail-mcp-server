/**
 * Core internal result type (HLD §13.3) and canonical error shape (§17).
 *
 * Internal modules pass `AppResult<T>` around; tools convert it into MCP-friendly
 * JSON at the edge (§13.3). `AppError` matches the §17 error object exactly, and
 * its `code` is the closed union of the 16 standard error codes, so using an
 * unknown code is a compile-time error.
 *
 * The runtime enumeration of these codes and the error factory live in
 * `src/mcp/errors.ts` (Step 1.1), which builds on the `ErrorCode` type defined
 * here. This keeps the dependency direction clean: `util` imports nothing.
 */

/** The 16 standard error codes from HLD §17 (verbatim, in document order). */
export type ErrorCode =
  | 'invalid_input'
  | 'not_authenticated'
  | 'insufficient_scope'
  | 'feature_disabled'
  | 'gmail_api_error'
  | 'rate_limited'
  | 'not_found'
  | 'permission_denied'
  | 'confirmation_required'
  | 'path_not_allowed'
  | 'file_blocked'
  | 'file_too_large'
  | 'mime_type_blocked'
  | 'decode_failed'
  | 'network_error'
  | 'internal_error';

/**
 * Canonical error object (HLD §17 / §11.1). `details` is an optional bag of
 * structured, JSON-serializable context (e.g. `requiredAnyOf`/`granted` for
 * `insufficient_scope`). `retryable` is always present.
 */
export interface AppError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

/** Internal discriminated-union result (HLD §13.3). */
export type AppResult<T> = { ok: true; value: T } | { ok: false; error: AppError };

/** Construct a success result. */
export function ok<T>(value: T): AppResult<T> {
  return { ok: true, value };
}

/** Construct a failure result from an `AppError`. */
export function err<T = never>(error: AppError): AppResult<T> {
  return { ok: false, error };
}

/** Type guard narrowing an `AppResult` to its success branch. */
export function isOk<T>(result: AppResult<T>): result is { ok: true; value: T } {
  return result.ok;
}

/** Type guard narrowing an `AppResult` to its failure branch. */
export function isErr<T>(result: AppResult<T>): result is { ok: false; error: AppError } {
  return !result.ok;
}

/**
 * Map the success value of an `AppResult`, passing failures through unchanged.
 * Useful for adapting an inner result to an outer shape without unwrapping.
 */
export function mapOk<T, U>(result: AppResult<T>, fn: (value: T) => U): AppResult<U> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Unwrap a success value or throw — for tests and truly-unreachable failures. */
export function unwrap<T>(result: AppResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `unwrap() called on an error result: ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value;
}
