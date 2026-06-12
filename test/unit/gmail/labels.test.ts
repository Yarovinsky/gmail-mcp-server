import { describe, it, expect } from 'vitest';
import { listLabels, createLabel } from '../../../src/gmail/labels.js';
import { GmailClient, type GmailApi } from '../../../src/gmail/gmailClient.js';

const noWait = { sleep: async (): Promise<void> => {}, random: (): number => 0 };

const COUNTS: Record<string, Record<string, number>> = {
  INBOX: { messagesTotal: 100, messagesUnread: 5, threadsTotal: 80, threadsUnread: 4 },
  Label_1: { messagesTotal: 12, messagesUnread: 1, threadsTotal: 10, threadsUnread: 1 },
};

interface FakeOptions {
  listThrows?: unknown;
  getThrowsForId?: string;
}

function makeClient(options: FakeOptions = {}): GmailClient {
  const api = {
    users: {
      labels: {
        list: async () => {
          if (options.listThrows) throw options.listThrows;
          return {
            data: {
              labels: [
                { id: 'INBOX', name: 'INBOX', type: 'system' },
                { id: 'Label_1', name: 'Work', type: 'user' },
              ],
            },
          };
        },
        get: async ({ id }: { id: string }) => {
          if (options.getThrowsForId === id) {
            throw Object.assign(new Error('forbidden'), { response: { status: 403 } });
          }
          return { data: { id, ...COUNTS[id] } };
        },
      },
    },
  } as unknown as GmailApi;
  return new GmailClient(api, { retry: noWait });
}

describe('listLabels (§12.2, §18)', () => {
  it('returns system + user labels with counts populated from details', async () => {
    const result = await listLabels(makeClient(), { includeSystem: true, includeUser: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);

    const inbox = result.value.find((l) => l.id === 'INBOX');
    expect(inbox).toMatchObject({
      id: 'INBOX',
      name: 'INBOX',
      type: 'system',
      messagesTotal: 100,
      messagesUnread: 5,
      threadsTotal: 80,
      threadsUnread: 4,
    });
    const work = result.value.find((l) => l.id === 'Label_1');
    expect(work).toMatchObject({ name: 'Work', type: 'user', messagesTotal: 12 });
  });

  it('filters to system labels only', async () => {
    const result = await listLabels(makeClient(), { includeSystem: true, includeUser: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((l) => l.id)).toEqual(['INBOX']);
    }
  });

  it('filters to user labels only', async () => {
    const result = await listLabels(makeClient(), { includeSystem: false, includeUser: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((l) => l.id)).toEqual(['Label_1']);
    }
  });

  it('degrades to zero counts when a label detail fetch fails', async () => {
    const result = await listLabels(makeClient({ getThrowsForId: 'INBOX' }), {
      includeSystem: true,
      includeUser: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inbox = result.value.find((l) => l.id === 'INBOX');
    expect(inbox).toMatchObject({ messagesTotal: 0, messagesUnread: 0, threadsTotal: 0 });
    // Other labels are unaffected.
    expect(result.value.find((l) => l.id === 'Label_1')?.messagesTotal).toBe(12);
  });

  it('propagates a failure from the list call', async () => {
    const err403 = Object.assign(new Error('forbidden'), { response: { status: 403 } });
    const result = await listLabels(makeClient({ listThrows: err403 }), {
      includeSystem: true,
      includeUser: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('permission_denied');
  });
});

interface CreateCaptured {
  body?: { name?: string; labelListVisibility?: string; messageListVisibility?: string };
}

function makeCreateClient(captured: CreateCaptured, throws?: unknown): GmailClient {
  const api = {
    users: {
      labels: {
        create: async (params: { requestBody?: CreateCaptured['body'] }) => {
          if (throws) throw throws;
          captured.body = params.requestBody;
          return { data: { id: 'Label_42', name: params.requestBody?.name } };
        },
      },
    },
  } as unknown as GmailApi;
  return new GmailClient(api, { retry: { ...noWait, maxAttempts: 2 } });
}

describe('createLabel (§12.16)', () => {
  it('creates a label and returns its id and name', async () => {
    const captured: CreateCaptured = {};
    const result = await createLabel(makeCreateClient(captured), {
      name: 'Projects/Example',
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ id: 'Label_42', name: 'Projects/Example' });
    expect(captured.body).toEqual({
      name: 'Projects/Example',
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    });
  });

  it('propagates a duplicate-name conflict as an error', async () => {
    const conflict = Object.assign(new Error('exists'), { response: { status: 409 } });
    const result = await createLabel(makeCreateClient({}, conflict), {
      name: 'INBOX',
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('gmail_api_error');
  });
});
