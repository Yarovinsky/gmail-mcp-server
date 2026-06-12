import { describe, it, expect } from 'vitest';
import { fetchAttachmentData } from '../../../src/gmail/attachments.js';
import { GmailClient, type GmailApi } from '../../../src/gmail/gmailClient.js';
import { encodeBase64Url } from '../../../src/mime/base64url.js';

const noWait = { sleep: async (): Promise<void> => {}, random: (): number => 0 };

function clientReturning(data: unknown): GmailClient {
  const api = {
    users: { messages: { attachments: { get: async () => ({ data }) } } },
  } as unknown as GmailApi;
  return new GmailClient(api, { retry: noWait });
}

function clientThrowing(error: unknown): GmailClient {
  const api = {
    users: {
      messages: {
        attachments: {
          get: async () => {
            throw error;
          },
        },
      },
    },
  } as unknown as GmailApi;
  return new GmailClient(api, { retry: noWait });
}

describe('fetchAttachmentData (§5.1, §12.7)', () => {
  it('decodes base64url bytes and reports sizes', async () => {
    const payload = Buffer.from('hello attachment');
    const result = await fetchAttachmentData(
      clientReturning({ data: encodeBase64Url(payload), size: payload.length }),
      'm1',
      'att-1',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Buffer.from(result.value.bytes).toString()).toBe('hello attachment');
      expect(result.value.size).toBe(payload.length);
      expect(result.value.declaredSize).toBe(payload.length);
      expect(result.value.warnings).toEqual([]);
    }
  });

  it('returns empty bytes (no warning) when data is absent', async () => {
    const result = await fetchAttachmentData(clientReturning({ size: 0 }), 'm1', 'att-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.size).toBe(0);
      expect(result.value.warnings).toEqual([]);
    }
  });

  it('surfaces a decode warning for malformed base64url', async () => {
    const result = await fetchAttachmentData(
      clientReturning({ data: '@@@not-base64@@@' }),
      'm',
      'a',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.warnings.length).toBeGreaterThan(0);
  });

  it('passes through a mapped Gmail API error', async () => {
    const httpErr = Object.assign(new Error('gone'), { response: { status: 404 } });
    const result = await fetchAttachmentData(clientThrowing(httpErr), 'm', 'a');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });
});
