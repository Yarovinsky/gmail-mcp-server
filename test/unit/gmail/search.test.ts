import { describe, it, expect } from 'vitest';
import { searchMessages, type SearchInput } from '../../../src/gmail/search.js';
import { GmailClient, type GmailApi } from '../../../src/gmail/gmailClient.js';

const noWait = { sleep: async (): Promise<void> => {}, random: (): number => 0 };

interface Spy {
  getCalls: number;
  lastListParams?: Record<string, unknown>;
}

function detail(id: string, threadId: string, withAttachment: boolean): unknown {
  const headers = withAttachment
    ? [
        { name: 'From', value: 'sender@example.com' },
        { name: 'To', value: 'user@example.com' },
        { name: 'Subject', value: 'Has a PDF' },
        { name: 'Date', value: 'Mon, 1 Jun 2026 12:15:00 +0300' },
      ]
    : [
        { name: 'From', value: 'other@example.com' },
        { name: 'Subject', value: 'Plain note' },
        { name: 'Date', value: 'Tue, 2 Jun 2026 08:00:00 +0300' },
      ];
  const payload = withAttachment
    ? {
        mimeType: 'multipart/mixed',
        headers,
        parts: [
          { mimeType: 'text/plain' },
          {
            mimeType: 'application/pdf',
            filename: 'doc.pdf',
            body: { attachmentId: 'att1', size: 10 },
          },
        ],
      }
    : { mimeType: 'text/plain', headers, body: {} };
  return {
    id,
    threadId,
    labelIds: ['INBOX'],
    snippet: `snippet ${id}`,
    internalDate: '1748765700000',
    payload,
  };
}

function makeClient(spy: Spy): GmailClient {
  const api = {
    users: {
      messages: {
        list: async (params: Record<string, unknown>) => {
          spy.lastListParams = params;
          return {
            data: {
              messages: [
                { id: 'm1', threadId: 't1' },
                { id: 'm2', threadId: 't2' },
              ],
              nextPageToken: 'NEXT',
            },
          };
        },
        get: async ({ id }: { id: string }) => {
          spy.getCalls += 1;
          return { data: detail(id, id === 'm1' ? 't1' : 't2', id === 'm1') };
        },
      },
    },
  } as unknown as GmailApi;
  return new GmailClient(api, { retry: noWait });
}

const baseInput: SearchInput = { maxResults: 10, format: 'metadata' };

describe('searchMessages (§12.3, §18)', () => {
  it('format "id" returns only id/threadId and does not fetch details', async () => {
    const spy: Spy = { getCalls: 0 };
    const result = await searchMessages(makeClient(spy), { ...baseInput, format: 'id' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spy.getCalls).toBe(0);
    expect(result.value.messages).toEqual([
      { id: 'm1', threadId: 't1' },
      { id: 'm2', threadId: 't2' },
    ]);
    expect(result.value.nextPageToken).toBe('NEXT');
  });

  it('format "summary" returns the reduced fields without the "to" header', async () => {
    const spy: Spy = { getCalls: 0 };
    const result = await searchMessages(makeClient(spy), { ...baseInput, format: 'summary' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(spy.getCalls).toBe(2);

    const first = result.value.messages[0] as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual(
      ['hasAttachments', 'headers', 'id', 'internalDate', 'labelIds', 'snippet', 'threadId'].sort(),
    );
    expect(Object.keys(first.headers as object).sort()).toEqual(['date', 'from', 'subject']);
    expect(first.hasAttachments).toBe(true);
    expect((result.value.messages[1] as { hasAttachments: boolean }).hasAttachments).toBe(false);
  });

  it('format "metadata" adds the "to" header', async () => {
    const spy: Spy = { getCalls: 0 };
    const result = await searchMessages(makeClient(spy), { ...baseInput, format: 'metadata' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const first = result.value.messages[0] as { headers: Record<string, unknown> };
    expect(Object.keys(first.headers).sort()).toEqual(['date', 'from', 'subject', 'to']);
    expect(first.headers.to).toBe('user@example.com');
    expect(first.headers.from).toBe('sender@example.com');
  });

  it('never returns a message body', async () => {
    const result = await searchMessages(makeClient({ getCalls: 0 }), {
      ...baseInput,
      format: 'metadata',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const message of result.value.messages) {
      const keys = Object.keys(message);
      expect(keys).not.toContain('body');
      expect(keys).not.toContain('text');
      expect(keys).not.toContain('html');
    }
  });

  it('passes query/labelIds/maxResults/pageToken through to messages.list', async () => {
    const spy: Spy = { getCalls: 0 };
    await searchMessages(makeClient(spy), {
      query: 'has:attachment',
      labelIds: ['INBOX'],
      includeSpamTrash: true,
      maxResults: 25,
      pageToken: 'PT',
      format: 'id',
    });
    expect(spy.lastListParams).toMatchObject({
      userId: 'me',
      q: 'has:attachment',
      labelIds: ['INBOX'],
      includeSpamTrash: true,
      maxResults: 25,
      pageToken: 'PT',
    });
  });

  it('omits nextPageToken when Gmail returns none', async () => {
    const api = {
      users: {
        messages: {
          list: async () => ({ data: { messages: [{ id: 'm1', threadId: 't1' }] } }),
          get: async () => ({ data: detail('m1', 't1', false) }),
        },
      },
    } as unknown as GmailApi;
    const client = new GmailClient(api, { retry: noWait });
    const result = await searchMessages(client, { ...baseInput, format: 'id' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toHaveProperty('nextPageToken');
  });
});
