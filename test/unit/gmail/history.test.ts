import { describe, it, expect } from 'vitest';
import { getHistory } from '../../../src/gmail/history.js';
import { GmailClient, type GmailApi } from '../../../src/gmail/gmailClient.js';

const noWait = { sleep: async (): Promise<void> => {}, random: (): number => 0 };

interface Captured {
  params?: Record<string, unknown>;
}

interface FakeData {
  history?: unknown[];
  nextPageToken?: string;
  historyId?: string;
}

function makeClient(captured: Captured, data: FakeData = {}, throws?: unknown): GmailClient {
  const api = {
    users: {
      history: {
        list: async (params: Record<string, unknown>) => {
          if (throws) throw throws;
          captured.params = params;
          const out: Record<string, unknown> = { history: data.history ?? [] };
          if (data.nextPageToken !== undefined) out.nextPageToken = data.nextPageToken;
          if (data.historyId !== undefined) out.historyId = data.historyId;
          return { data: out };
        },
      },
    },
  } as unknown as GmailApi;
  return new GmailClient(api, { retry: { ...noWait, maxAttempts: 2 } });
}

describe('getHistory (§12.17, §18)', () => {
  it('passes through query params and returns history + historyId + nextPageToken', async () => {
    const captured: Captured = {};
    const client = makeClient(captured, {
      history: [{ id: 'h1', messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }],
      nextPageToken: 'np-1',
      historyId: '123999',
    });
    const result = await getHistory(client, {
      startHistoryId: '123456',
      historyTypes: ['messageAdded', 'labelAdded'],
      labelId: 'INBOX',
      maxResults: 25,
      pageToken: 'pt-0',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(captured.params).toMatchObject({
      userId: 'me',
      startHistoryId: '123456',
      historyTypes: ['messageAdded', 'labelAdded'],
      labelId: 'INBOX',
      maxResults: 25,
      pageToken: 'pt-0',
    });
    expect(result.value.history).toHaveLength(1);
    expect(result.value.nextPageToken).toBe('np-1');
    expect(result.value.historyId).toBe('123999');
  });

  it('omits nextPageToken and defaults historyId to null when absent', async () => {
    const captured: Captured = {};
    const result = await getHistory(makeClient(captured, { history: [] }), {
      startHistoryId: '1',
      maxResults: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.history).toEqual([]);
    expect(result.value.nextPageToken).toBeUndefined();
    expect(result.value.historyId).toBeNull();
  });

  it('propagates a not_found (e.g. expired startHistoryId) as an error', async () => {
    const expired = Object.assign(new Error('not found'), { response: { status: 404 } });
    const result = await getHistory(makeClient({}, {}, expired), {
      startHistoryId: 'expired',
      maxResults: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });
});
