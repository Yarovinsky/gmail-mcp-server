import { describe, it, expect } from 'vitest';
import { createDraft, listDrafts, sendDraft } from '../../../src/gmail/drafts.js';
import { GmailClient, type GmailApi } from '../../../src/gmail/gmailClient.js';

const noWait = { sleep: async (): Promise<void> => {}, random: (): number => 0 };

/** Decode a Gmail `raw` (base64url) message back to text. */
function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

interface Captured {
  createBody?: { message?: { raw?: string; threadId?: string } };
  listParams?: Record<string, unknown>;
  sendCalls: number;
}

interface FakeOptions {
  /** Original message returned by messages.get (for reply threading). */
  original?: { threadId?: string; headers?: Array<{ name: string; value: string }> };
  draftStubs?: Array<{ id: string; message?: { id: string; threadId: string } }>;
  draftDetail?: Record<
    string,
    {
      id: string;
      message: {
        id: string;
        threadId: string;
        snippet: string;
        payload: { headers: Array<{ name: string; value: string }> };
      };
    }
  >;
  getThrowsForDraftId?: string;
  nextPageToken?: string;
  sendThrowsOnce?: unknown;
}

function makeClient(captured: Captured, options: FakeOptions = {}): GmailClient {
  let sendThrown = false;
  const api = {
    users: {
      messages: {
        get: async ({ id }: { id: string }) => ({
          data: {
            id,
            threadId: options.original?.threadId ?? 't1',
            payload: { headers: options.original?.headers ?? [] },
          },
        }),
      },
      drafts: {
        create: async (params: { requestBody?: Captured['createBody'] }) => {
          captured.createBody = params.requestBody;
          return { data: { id: 'draft-1', message: { id: 'msg-1', threadId: 'thr-1' } } };
        },
        list: async (params: Record<string, unknown>) => {
          captured.listParams = params;
          const data: Record<string, unknown> = { drafts: options.draftStubs ?? [] };
          if (options.nextPageToken !== undefined) data.nextPageToken = options.nextPageToken;
          return { data };
        },
        get: async ({ id }: { id: string }) => {
          if (options.getThrowsForDraftId === id) {
            throw Object.assign(new Error('boom'), { response: { status: 500 } });
          }
          return { data: options.draftDetail?.[id] ?? { id, message: {} } };
        },
        send: async () => {
          captured.sendCalls += 1;
          if (options.sendThrowsOnce && !sendThrown) {
            sendThrown = true;
            throw options.sendThrowsOnce;
          }
          return { data: { id: 'sent-1', threadId: 'thr-1' } };
        },
      },
    },
  } as unknown as GmailApi;
  return new GmailClient(api, { retry: { ...noWait, maxAttempts: 5 } });
}

describe('createDraft (§12.10)', () => {
  it('creates a simple draft and returns its ids', async () => {
    const captured: Captured = { sendCalls: 0 };
    const result = await createDraft(makeClient(captured), {
      to: ['a@example.com'],
      subject: 'Hi',
      bodyText: 'Hello',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ id: 'draft-1', messageId: 'msg-1', threadId: 'thr-1' });

    const raw = captured.createBody?.message?.raw ?? '';
    const decoded = decodeRaw(raw);
    expect(decoded).toContain('To: a@example.com');
    expect(decoded).toContain('Subject: Hi');
    // No reply → no threadId carried onto the message.
    expect(captured.createBody?.message?.threadId).toBeUndefined();
  });

  it('threads a reply: carries threadId and sets In-Reply-To/References with a Re: subject', async () => {
    const captured: Captured = { sendCalls: 0 };
    const client = makeClient(captured, {
      original: {
        threadId: 'orig-thread',
        headers: [
          { name: 'Message-ID', value: '<orig@mail.example.com>' },
          { name: 'Subject', value: 'Original topic' },
        ],
      },
    });
    const result = await createDraft(client, {
      to: ['a@example.com'],
      bodyText: 'reply body',
      replyToMessageId: 'orig-msg',
    });
    expect(result.ok).toBe(true);

    expect(captured.createBody?.message?.threadId).toBe('orig-thread');
    const decoded = decodeRaw(captured.createBody?.message?.raw ?? '');
    expect(decoded).toContain('In-Reply-To: <orig@mail.example.com>');
    expect(decoded).toContain('References: <orig@mail.example.com>');
    expect(decoded).toContain('Subject: Re: Original topic');
  });

  it('does not double-prefix a subject that already starts with Re:', async () => {
    const captured: Captured = { sendCalls: 0 };
    const client = makeClient(captured, {
      original: {
        threadId: 'orig-thread',
        headers: [{ name: 'Subject', value: 'Re: Already replied' }],
      },
    });
    await createDraft(client, { to: ['a@example.com'], bodyText: 'x', replyToMessageId: 'm' });
    const decoded = decodeRaw(captured.createBody?.message?.raw ?? '');
    expect(decoded).toContain('Subject: Re: Already replied');
    expect(decoded).not.toContain('Re: Re:');
  });

  it('rejects a draft with no recipients (invalid_input from the RFC822 builder)', async () => {
    const captured: Captured = { sendCalls: 0 };
    const result = await createDraft(makeClient(captured), { to: [], bodyText: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_input');
    // The builder rejected it before any drafts.create call.
    expect(captured.createBody).toBeUndefined();
  });

  it('rejects a non-empty attachmentsFromLocalPaths with invalid_input (§3 #9)', async () => {
    const captured: Captured = { sendCalls: 0 };
    const result = await createDraft(makeClient(captured), {
      to: ['a@example.com'],
      bodyText: 'x',
      attachmentsFromLocalPaths: ['/tmp/x.pdf'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_input');
  });
});

describe('listDrafts (§12.11, §18)', () => {
  it('lists draft summaries with headers + snippet and passes through the page token', async () => {
    const captured: Captured = { sendCalls: 0 };
    const client = makeClient(captured, {
      draftStubs: [{ id: 'd1', message: { id: 'm1', threadId: 't1' } }],
      draftDetail: {
        d1: {
          id: 'd1',
          message: {
            id: 'm1',
            threadId: 't1',
            snippet: 'hello there',
            payload: {
              headers: [
                { name: 'To', value: 'bob@example.com' },
                { name: 'Subject', value: 'Greetings' },
              ],
            },
          },
        },
      },
      nextPageToken: 'np-1',
    });
    const result = await listDrafts(client, { maxResults: 5, pageToken: 'pt-0' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(captured.listParams).toMatchObject({ maxResults: 5, pageToken: 'pt-0' });
    expect(result.value.nextPageToken).toBe('np-1');
    expect(result.value.drafts).toEqual([
      {
        id: 'd1',
        message: {
          id: 'm1',
          threadId: 't1',
          headers: { to: 'bob@example.com', subject: 'Greetings' },
          snippet: 'hello there',
        },
      },
    ]);
  });

  it('omits nextPageToken when Gmail returns none', async () => {
    const captured: Captured = { sendCalls: 0 };
    const client = makeClient(captured, { draftStubs: [] });
    const result = await listDrafts(client, { maxResults: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.nextPageToken).toBeUndefined();
  });

  it('degrades a failed per-draft fetch to a usable stub rather than failing all', async () => {
    const captured: Captured = { sendCalls: 0 };
    const client = makeClient(captured, {
      draftStubs: [{ id: 'd1', message: { id: 'm1', threadId: 't1' } }],
      getThrowsForDraftId: 'd1',
    });
    const result = await listDrafts(client, { maxResults: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.drafts[0]).toEqual({
      id: 'd1',
      message: {
        id: 'm1',
        threadId: 't1',
        headers: { to: null, subject: null },
        snippet: '',
      },
    });
  });
});

describe('sendDraft (§12.12, §19)', () => {
  it('sends a draft and returns the sent message ids', async () => {
    const captured: Captured = { sendCalls: 0 };
    const result = await sendDraft(makeClient(captured), 'draft-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ id: 'sent-1', threadId: 'thr-1' });
  });

  it('does not auto-retry a non-idempotent send on a transient failure (§19)', async () => {
    const captured: Captured = { sendCalls: 0 };
    const transient = Object.assign(new Error('rate limited'), { response: { status: 429 } });
    const client = makeClient(captured, { sendThrowsOnce: transient });
    const result = await sendDraft(client, 'draft-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('rate_limited');
    // Called exactly once — the send was not retried despite the retryable status.
    expect(captured.sendCalls).toBe(1);
  });
});
