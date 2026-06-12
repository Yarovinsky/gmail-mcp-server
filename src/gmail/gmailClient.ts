/**
 * Typed wrapper over the Google Gmail API client with retry/backoff (HLD §13.2, §19).
 *
 * Every Gmail call in the server goes through {@link GmailClient.execute}, which
 * centralizes transient-failure handling: HTTP 429/500/502/503/504 and network
 * timeouts are retried with exponential backoff + full jitter (§19). Operations
 * that are NOT idempotent (notably message sends) are never auto-retried, since a
 * retried send could deliver a duplicate (§19) — callers pass `idempotent: false`.
 *
 * This module imports only the Google API client (`googleapis`); per §13.2 the
 * `gmail` layer must NOT import the MCP SDK, `auth`, or `tools`. The OAuth2 client
 * is accepted structurally by {@link createGmailApi} so no `auth` import is needed.
 */

import { google, type gmail_v1 } from 'googleapis';
import { type AppResult, err, ok } from '../util/result.js';
import { fromGmailApiError } from '../mcp/errors.js';
import { backoffDelayMs, sleep } from '../util/async.js';
import type { Logger } from '../util/logger.js';

/** The authenticated Gmail API surface (Google's `gmail_v1.Gmail`). */
export type GmailApi = gmail_v1.Gmail;

/** A google `OAuth2`-shaped auth client, typed without importing the auth layer. */
export type GoogleAuthClient = InstanceType<typeof google.auth.OAuth2>;

/**
 * Build an authenticated Gmail API client from a Google OAuth2 client. The
 * underlying client refreshes access tokens on demand when a refresh token is set.
 */
export function createGmailApi(auth: GoogleAuthClient): GmailApi {
  return google.gmail({ version: 'v1', auth });
}

/** Retry policy for transient Gmail failures (§19). All fields injectable for tests. */
export interface RetryPolicy {
  /** Maximum total attempts, including the first try. */
  maxAttempts: number;
  /** Base delay for the exponential backoff (ms). */
  baseMs: number;
  /** Maximum single backoff delay (ms). */
  capMs: number;
  /** Random source for jitter (0..1). */
  random: () => number;
  /** Sleep implementation (overridden in tests to avoid real delays). */
  sleep: (ms: number) => Promise<void>;
}

/** Default retry policy: up to 5 attempts, 250ms base, 10s cap, full jitter (§19). */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseMs: 250,
  capMs: 10_000,
  random: Math.random,
  sleep,
};

export interface GmailClientOptions {
  logger?: Logger;
  retry?: Partial<RetryPolicy>;
}

/** A single Gmail operation to run through the retrying executor. */
export interface GmailOp<T> {
  /** Short label (the Gmail method name) for log/diagnostic context. */
  label: string;
  /**
   * Whether the operation is safe to auto-retry on transient failures. Reads and
   * other idempotent mutations default to `true`; non-idempotent sends MUST pass
   * `false` so a transient failure never triggers a duplicate delivery (§19).
   */
  idempotent?: boolean;
  /** Perform the actual Gmail call against the wrapped API client. */
  run: (api: GmailApi) => Promise<T>;
}

export class GmailClient {
  /** The wrapped Gmail API client. Exposed read-only for callers that need it. */
  readonly api: GmailApi;
  private readonly policy: RetryPolicy;
  private readonly logger: Logger | undefined;

  constructor(api: GmailApi, options: GmailClientOptions = {}) {
    this.api = api;
    this.policy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.logger = options.logger;
  }

  /**
   * Run a Gmail operation with retry/backoff, returning an `AppResult`. On success
   * the resolved value is returned as `ok`. On failure the thrown error is mapped
   * to a canonical §17 `AppError`; transient, retryable failures are retried with
   * backoff while attempts remain and the operation is idempotent.
   */
  async execute<T>(op: GmailOp<T>): Promise<AppResult<T>> {
    const idempotent = op.idempotent ?? true;
    let attempt = 0;
    for (;;) {
      try {
        const value = await op.run(this.api);
        return ok(value);
      } catch (raw) {
        const error = fromGmailApiError(raw);
        const attemptsLeft = attempt < this.policy.maxAttempts - 1;
        const canRetry = idempotent && error.retryable && attemptsLeft;
        if (!canRetry) {
          this.logger?.debug(
            { label: op.label, code: error.code, attempt, idempotent, retryable: error.retryable },
            'Gmail call failed; not retrying.',
          );
          return err(error);
        }
        const delayMs = backoffDelayMs(attempt, {
          baseMs: this.policy.baseMs,
          capMs: this.policy.capMs,
          random: this.policy.random,
        });
        this.logger?.warn(
          { label: op.label, code: error.code, attempt, delayMs },
          'Transient Gmail failure; retrying after backoff.',
        );
        await this.policy.sleep(delayMs);
        attempt += 1;
      }
    }
  }
}
