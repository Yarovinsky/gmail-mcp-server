import { describe, it, expect } from 'vitest';
import { sendMessage } from '../../../src/gmail/send.js';
import { GmailClient, type GmailApi } from '../../../src/gmail/gmailClient.js';

const noWait = { sleep: async (): Promise<void> => {}, random: (): number => 0 };

/** Decode a Gmail `raw` (base64url) message back to text. */
function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

interface Captured {
  sendBody?: { raw?: string };
  sendCalls: number;
}

interface FakeOptions {
  throwsOnce?: unknown;
}

function makeClient(captured: Captured, options: FakeOptions = {}): GmailClient {
  let thrown = false;
  const api = {
    users: {
      messages: {
        send: async (params: { requestBody?: Captured['sendBody'] }) => {
          captured.sendCalls += 1;
          captured.sendBody = params.requestBody;
          if (options.throwsOnce && !thrown) {
            thrown = true;
            throw options.throwsOnce;
          }
          return { data: { id: 'sent-1', threadId: 'thr-1' } };
        },
      },
    },
  } as unknown as GmailApi;
  return new GmailClient(api, { retry: { ...noWait, maxAttempts: 5 } });
}

describe('sendMessage (§12.13, §19)', () => {
  it('builds the RFC822 message and sends it, returning the message ids', async () => {
    const captured: Captured = { sendCalls: 0 };
    const result = await sendMessage(makeClient(captured), {
      to: ['a@example.com'],
      subject: 'Hi',
      bodyText: 'Hello',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ id: 'sent-1', threadId: 'thr-1' });

    const decoded = decodeRaw(captured.sendBody?.raw ?? '');
    expect(decoded).toContain('To: a@example.com');
    expect(decoded).toContain('Subject: Hi');
  });

  it('does not auto-retry a non-idempotent send on a transient failure (§19)', async () => {
    const captured: Captured = { sendCalls: 0 };
    const transient = Object.assign(new Error('rate limited'), { response: { status: 429 } });
    const result = await sendMessage(makeClient(captured, { throwsOnce: transient }), {
      to: ['a@example.com'],
      bodyText: 'x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('rate_limited');
    expect(captured.sendCalls).toBe(1); // not retried
  });

  it('rejects a message with no recipients (invalid_input) before sending', async () => {
    const captured: Captured = { sendCalls: 0 };
    const result = await sendMessage(makeClient(captured), { to: [], bodyText: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_input');
    expect(captured.sendCalls).toBe(0);
  });

  it('rejects a non-empty attachmentsFromLocalPaths with invalid_input (§3 #9)', async () => {
    const captured: Captured = { sendCalls: 0 };
    const result = await sendMessage(makeClient(captured), {
      to: ['a@example.com'],
      bodyText: 'x',
      attachmentsFromLocalPaths: ['/tmp/x.pdf'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_input');
    expect(captured.sendCalls).toBe(0);
  });
});
