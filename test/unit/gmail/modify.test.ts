import { describe, it, expect } from 'vitest';
import { modifyMessageLabels, trashMessages } from '../../../src/gmail/modify.js';
import { GmailClient, type GmailApi } from '../../../src/gmail/gmailClient.js';

const noWait = { sleep: async (): Promise<void> => {}, random: (): number => 0 };

interface Captured {
  modifyCalls: Array<{ id: string; addLabelIds?: string[]; removeLabelIds?: string[] }>;
  trashCalls: string[];
}

interface FakeOptions {
  /** Message ids whose modify/trash call should throw (mapped to status). */
  failForId?: Record<string, number>;
}

function makeClient(captured: Captured, options: FakeOptions = {}): GmailClient {
  const maybeThrow = (id: string): void => {
    const status = options.failForId?.[id];
    if (status) throw Object.assign(new Error('boom'), { response: { status } });
  };
  const api = {
    users: {
      messages: {
        modify: async (params: {
          id: string;
          requestBody?: { addLabelIds?: string[]; removeLabelIds?: string[] };
        }) => {
          maybeThrow(params.id);
          captured.modifyCalls.push({
            id: params.id,
            addLabelIds: params.requestBody?.addLabelIds,
            removeLabelIds: params.requestBody?.removeLabelIds,
          });
          return { data: { id: params.id } };
        },
        trash: async (params: { id: string }) => {
          maybeThrow(params.id);
          captured.trashCalls.push(params.id);
          return { data: { id: params.id, labelIds: ['TRASH'] } };
        },
      },
    },
  } as unknown as GmailApi;
  return new GmailClient(api, { retry: { ...noWait, maxAttempts: 2 } });
}

function freshCaptured(): Captured {
  return { modifyCalls: [], trashCalls: [] };
}

describe('modifyMessageLabels (§12.14)', () => {
  it('applies add/remove label sets to each message', async () => {
    const captured = freshCaptured();
    const result = await modifyMessageLabels(makeClient(captured), {
      messageIds: ['m1', 'm2'],
      addLabelIds: ['Label_1'],
      removeLabelIds: ['INBOX'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.modified).toEqual(['m1', 'm2']);
    expect(result.value.failed).toEqual([]);
    expect(captured.modifyCalls).toEqual([
      { id: 'm1', addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] },
      { id: 'm2', addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] },
    ]);
  });

  it('splits successes and failures without aborting the batch', async () => {
    const captured = freshCaptured();
    const client = makeClient(captured, { failForId: { m2: 404 } });
    const result = await modifyMessageLabels(client, {
      messageIds: ['m1', 'm2', 'm3'],
      addLabelIds: ['Label_1'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.modified).toEqual(['m1', 'm3']);
    expect(result.value.failed).toHaveLength(1);
    expect(result.value.failed[0]).toMatchObject({ messageId: 'm2', code: 'not_found' });
  });

  it('defaults missing label arrays to empty', async () => {
    const captured = freshCaptured();
    const result = await modifyMessageLabels(makeClient(captured), { messageIds: ['m1'] });
    expect(result.ok).toBe(true);
    expect(captured.modifyCalls[0]).toEqual({ id: 'm1', addLabelIds: [], removeLabelIds: [] });
  });
});

describe('trashMessages (§12.15)', () => {
  it('moves each message to Trash', async () => {
    const captured = freshCaptured();
    const result = await trashMessages(makeClient(captured), ['m1', 'm2']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trashed).toEqual(['m1', 'm2']);
    expect(result.value.failed).toEqual([]);
    expect(captured.trashCalls).toEqual(['m1', 'm2']);
  });

  it('reports a failed trash without aborting the rest', async () => {
    const captured = freshCaptured();
    const client = makeClient(captured, { failForId: { m1: 403 } });
    const result = await trashMessages(client, ['m1', 'm2']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trashed).toEqual(['m2']);
    expect(result.value.failed[0]).toMatchObject({ messageId: 'm1', code: 'permission_denied' });
  });
});
