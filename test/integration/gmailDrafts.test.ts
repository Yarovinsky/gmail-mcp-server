import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailCreateDraftTool } from '../../src/tools/gmailCreateDraft.js';
import { gmailListDraftsTool } from '../../src/tools/gmailListDrafts.js';
import { gmailSendDraftTool } from '../../src/tools/gmailSendDraft.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { defaultConfig } from '../../src/config/configSchema.js';
import type { Config } from '../../src/config/config.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { Scope } from '../../src/auth/scopeProfiles.js';
import { CONFIRMATION_STRINGS } from '../../src/safety/confirmation.js';

interface Captured {
  createBody?: { message?: { raw?: string; threadId?: string } };
  listParams?: Record<string, unknown>;
  sendBody?: { id?: string };
}

function fakeSession(captured: Captured): GmailSession {
  const api = {
    users: {
      drafts: {
        create: async (params: { requestBody?: Captured['createBody'] }) => {
          captured.createBody = params.requestBody;
          return { data: { id: 'draft-1', message: { id: 'msg-1', threadId: 'thr-1' } } };
        },
        list: async (params: Record<string, unknown>) => {
          captured.listParams = params;
          return { data: { drafts: [{ id: 'd1', message: { id: 'm1', threadId: 't1' } }] } };
        },
        get: async ({ id }: { id: string }) => ({
          data: {
            id,
            message: {
              id: 'm1',
              threadId: 't1',
              snippet: 'hi',
              payload: {
                headers: [
                  { name: 'To', value: 'bob@example.com' },
                  { name: 'Subject', value: 'Greetings' },
                ],
              },
            },
          },
        }),
        send: async (params: { requestBody?: Captured['sendBody'] }) => {
          captured.sendBody = params.requestBody;
          return { data: { id: 'sent-1', threadId: 't1' } };
        },
      },
    },
  } as unknown as GmailApi;
  const gmail = new GmailClient(api, { retry: { sleep: async () => {}, random: () => 0 } });
  return { gmail, grantedScopes: [Scope.GmailCompose] };
}

/** A config with the drafts feature toggled (defaults otherwise). */
function configWithDrafts(drafts: boolean, overrides: Partial<Config['safety']> = {}): Config {
  const base = defaultConfig();
  return {
    ...base,
    features: { ...base.features, drafts },
    safety: { ...base.safety, ...overrides },
  };
}

async function connect(context: ToolContext, gate: ToolGate): Promise<Client> {
  const registry = new ToolRegistry();
  registry.register(gmailCreateDraftTool);
  registry.register(gmailListDraftsTool);
  registry.register(gmailSendDraftTool);
  const server = buildMcpServer({ registry, context, gate });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function clientFor(config: Config, captured: Captured): Promise<Client> {
  const session = fakeSession(captured);
  return connect(
    { config, logger: createSilentLogger(), session },
    buildToolGate(config, session.grantedScopes, true),
  );
}

describe('gmail_create_draft (§12.10)', () => {
  it('creates a draft when features.drafts is enabled', async () => {
    const captured: Captured = {};
    const client = await clientFor(configWithDrafts(true), captured);
    const result = await client.callTool({
      name: 'gmail_create_draft',
      arguments: { to: ['a@example.com'], subject: 'Hi', bodyText: 'Hello' },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      draft: { id: 'draft-1', messageId: 'msg-1', threadId: 'thr-1' },
    });
    await client.close();
  });

  it('returns feature_disabled when features.drafts is off (default)', async () => {
    const captured: Captured = {};
    const client = await clientFor(configWithDrafts(false), captured);
    const result = await client.callTool({
      name: 'gmail_create_draft',
      arguments: { to: ['a@example.com'], bodyText: 'x' },
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe(
      'feature_disabled',
    );
    await client.close();
  });
});

describe('gmail_list_drafts (§12.11, §18)', () => {
  it('lists drafts and clamps maxResults to maxPageSize', async () => {
    const captured: Captured = {};
    const client = await clientFor(configWithDrafts(true), captured);
    const result = await client.callTool({
      name: 'gmail_list_drafts',
      arguments: { maxResults: 9999 },
    });
    expect(result.isError).toBeFalsy();
    expect(captured.listParams?.maxResults).toBe(100); // clamped to maxPageSize
    const structured = result.structuredContent as {
      drafts: Array<{ id: string; message: { headers: { to: string; subject: string } } }>;
    };
    expect(structured.drafts[0]).toMatchObject({
      id: 'd1',
      message: { headers: { to: 'bob@example.com', subject: 'Greetings' }, snippet: 'hi' },
    });
    await client.close();
  });
});

describe('gmail_send_draft (§12.12, §16.3)', () => {
  it('requires confirmation when requireConfirmationForSend (default)', async () => {
    const captured: Captured = {};
    const client = await clientFor(configWithDrafts(true), captured);
    const result = await client.callTool({
      name: 'gmail_send_draft',
      arguments: { draftId: 'draft-1' },
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe(
      'confirmation_required',
    );
    // No send was attempted.
    expect(captured.sendBody).toBeUndefined();
    await client.close();
  });

  it('sends with the exact confirmation string', async () => {
    const captured: Captured = {};
    const client = await clientFor(configWithDrafts(true), captured);
    const result = await client.callTool({
      name: 'gmail_send_draft',
      arguments: { draftId: 'draft-1', confirmation: CONFIRMATION_STRINGS.send },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      sentMessage: { id: 'sent-1', threadId: 't1' },
    });
    expect(captured.sendBody).toEqual({ id: 'draft-1' });
    await client.close();
  });

  it('sends without confirmation when requireConfirmationForSend is false', async () => {
    const captured: Captured = {};
    const client = await clientFor(
      configWithDrafts(true, { requireConfirmationForSend: false }),
      captured,
    );
    const result = await client.callTool({
      name: 'gmail_send_draft',
      arguments: { draftId: 'draft-1' },
    });
    expect(result.isError).toBeFalsy();
    expect(captured.sendBody).toEqual({ id: 'draft-1' });
    await client.close();
  });
});
