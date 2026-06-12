import { describe, it, expect } from 'vitest';
import { GmailClient, DEFAULT_RETRY_POLICY, type GmailApi } from '../../src/gmail/gmailClient.js';

/** Build a Gaxios-shaped HTTP error (what googleapis throws on non-2xx). */
function httpError(status: number): Error & { response: { status: number } } {
  const e = new Error(`HTTP ${status}`) as Error & { response: { status: number } };
  e.response = { status };
  return e;
}

/** Build a bare network error (no HTTP response), e.g. a socket timeout. */
function networkError(code: string): Error & { code: string } {
  const e = new Error(code) as Error & { code: string };
  e.code = code;
  return e;
}

/** Retry policy with no real waiting and zero jitter, for deterministic tests. */
const noWait = { sleep: async (): Promise<void> => {}, random: (): number => 0 };

/** A placeholder API object; the run callback drives behavior in these tests. */
const NO_API = {} as unknown as GmailApi;

describe('GmailClient.execute retry/backoff (§19, §22.2 #9)', () => {
  it('retries a 429 then succeeds on the 200 (the §22.2 #9 case)', async () => {
    let calls = 0;
    const client = new GmailClient(NO_API, { retry: noWait });
    const result = await client.execute({
      label: 'users.getProfile',
      run: async () => {
        calls += 1;
        if (calls === 1) throw httpError(429);
        return { emailAddress: 'me@example.com' };
      },
    });

    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.emailAddress).toBe('me@example.com');
  });

  it('does NOT auto-retry a non-idempotent send', async () => {
    let calls = 0;
    const client = new GmailClient(NO_API, { retry: noWait });
    const result = await client.execute({
      label: 'users.messages.send',
      idempotent: false,
      run: async () => {
        calls += 1;
        throw httpError(429);
      },
    });

    expect(calls).toBe(1); // one attempt only — no retry despite a retryable status
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('rate_limited');
  });

  it('retries each transient HTTP status (500/502/503/504) then succeeds', async () => {
    for (const status of [500, 502, 503, 504]) {
      let calls = 0;
      const client = new GmailClient(NO_API, { retry: noWait });
      const result = await client.execute({
        label: `status-${status}`,
        run: async () => {
          calls += 1;
          if (calls === 1) throw httpError(status);
          return 'ok';
        },
      });
      expect(calls, `status ${status}`).toBe(2);
      expect(result.ok, `status ${status}`).toBe(true);
    }
  });

  it('retries network timeouts then succeeds', async () => {
    let calls = 0;
    const client = new GmailClient(NO_API, { retry: noWait });
    const result = await client.execute({
      label: 'users.threads.get',
      run: async () => {
        calls += 1;
        if (calls === 1) throw networkError('ETIMEDOUT');
        return 'ok';
      },
    });
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
  });

  it('gives up after maxAttempts on a persistent transient error', async () => {
    let calls = 0;
    const client = new GmailClient(NO_API, { retry: { ...noWait, maxAttempts: 3 } });
    const result = await client.execute({
      label: 'users.messages.list',
      run: async () => {
        calls += 1;
        throw httpError(503);
      },
    });
    expect(calls).toBe(3);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.retryable).toBe(true);
  });

  it('does not retry a non-retryable error (404 → not_found)', async () => {
    let calls = 0;
    const client = new GmailClient(NO_API, { retry: noWait });
    const result = await client.execute({
      label: 'users.messages.get',
      run: async () => {
        calls += 1;
        throw httpError(404);
      },
    });
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });

  it('passes the wrapped api instance to the run callback', async () => {
    const fakeApi = { marker: 'the-api' } as unknown as GmailApi;
    const client = new GmailClient(fakeApi, { retry: noWait });
    let received: unknown;
    const result = await client.execute({
      label: 'identity',
      run: async (api) => {
        received = api;
        return 42;
      },
    });
    expect(result.ok).toBe(true);
    expect(received).toBe(fakeApi);
  });

  it('exposes sane defaults in DEFAULT_RETRY_POLICY (§19)', () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_RETRY_POLICY.baseMs).toBeGreaterThan(0);
    expect(DEFAULT_RETRY_POLICY.capMs).toBeGreaterThanOrEqual(DEFAULT_RETRY_POLICY.baseMs);
  });
});
