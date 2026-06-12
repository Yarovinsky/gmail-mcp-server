import { describe, it, expect } from 'vitest';
import { getProfile } from '../../../src/gmail/profile.js';
import { GmailClient, type GmailApi } from '../../../src/gmail/gmailClient.js';

const noWait = { sleep: async (): Promise<void> => {}, random: (): number => 0 };

function clientReturning(data: unknown): GmailClient {
  const api = { users: { getProfile: async () => ({ data }) } } as unknown as GmailApi;
  return new GmailClient(api, { retry: noWait });
}

function clientThrowing(error: unknown): GmailClient {
  const api = {
    users: {
      getProfile: async () => {
        throw error;
      },
    },
  } as unknown as GmailApi;
  return new GmailClient(api, { retry: noWait });
}

describe('getProfile (§12.1)', () => {
  it('normalizes the Gmail profile response', async () => {
    const result = await getProfile(
      clientReturning({
        emailAddress: 'me@example.com',
        messagesTotal: 10,
        threadsTotal: 4,
        historyId: '99',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        emailAddress: 'me@example.com',
        messagesTotal: 10,
        threadsTotal: 4,
        historyId: '99',
      });
    }
  });

  it('fills sensible defaults for missing fields', async () => {
    const result = await getProfile(clientReturning({}));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        emailAddress: '',
        messagesTotal: 0,
        threadsTotal: 0,
        historyId: '',
      });
    }
  });

  it('passes through a mapped Gmail API error', async () => {
    const httpErr = Object.assign(new Error('nope'), { response: { status: 403 } });
    const result = await getProfile(clientThrowing(httpErr));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('permission_denied');
  });
});
