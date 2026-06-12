import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { createToolRegistry } from '../../src/tools/index.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { defaultConfig } from '../../src/config/configSchema.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { Scope } from '../../src/auth/scopeProfiles.js';

function fakeSession(): GmailSession {
  const api = {
    users: {
      getProfile: async () => ({
        data: {
          emailAddress: 'me@example.com',
          messagesTotal: 10,
          threadsTotal: 4,
          historyId: '99',
        },
      }),
      messages: {
        get: async ({ id }: { id: string }) => ({
          data: {
            id,
            threadId: 't1',
            labelIds: ['INBOX'],
            snippet: 'hi',
            internalDate: '1748765700000',
            payload: {
              mimeType: 'text/plain',
              headers: [{ name: 'Subject', value: 'Hello' }],
              body: { data: Buffer.from('plain body', 'utf8').toString('base64url') },
            },
          },
        }),
      },
    },
  } as unknown as GmailApi;
  const gmail = new GmailClient(api, { retry: { sleep: async () => {}, random: () => 0 } });
  return { gmail, grantedScopes: [Scope.GmailReadonly] };
}

async function connect(authenticated: boolean): Promise<Client> {
  const config = defaultConfig();
  const session = authenticated ? fakeSession() : null;
  const registry = createToolRegistry();
  const gate = buildToolGate(config, session?.grantedScopes ?? [], session !== null);
  const server = buildMcpServer({
    registry,
    context: { config, logger: createSilentLogger(), session },
    gate,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('MCP resources (§11.2)', () => {
  it('lists the static resources and the message/thread templates', async () => {
    const client = await connect(true);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(['gmail://profile', 'gmail://labels']),
    );
    const { resourceTemplates } = await client.listResourceTemplates();
    const templates = resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toEqual(
      expect.arrayContaining(['gmail://message/{messageId}', 'gmail://thread/{threadId}']),
    );
    await client.close();
  });

  it('reads gmail://profile as bounded JSON', async () => {
    const client = await connect(true);
    const result = await client.readResource({ uri: 'gmail://profile' });
    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content.mimeType).toBe('application/json');
    const parsed = JSON.parse(content.text as string);
    expect(parsed).toMatchObject({ ok: true, profile: { emailAddress: 'me@example.com' } });
    await client.close();
  });

  it('reads a templated message resource via its id', async () => {
    const client = await connect(true);
    const result = await client.readResource({ uri: 'gmail://message/m123' });
    const parsed = JSON.parse(result.contents[0].text as string);
    expect(parsed).toMatchObject({ ok: true, message: { id: 'm123' } });
    await client.close();
  });

  it('surfaces not_authenticated through the resource when there is no session', async () => {
    const client = await connect(false);
    const result = await client.readResource({ uri: 'gmail://profile' });
    const parsed = JSON.parse(result.contents[0].text as string);
    expect(parsed).toMatchObject({ ok: false, error: { code: 'not_authenticated' } });
    await client.close();
  });
});

describe('MCP prompts (§11.3)', () => {
  it('lists the four prompts', async () => {
    const client = await connect(true);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(
      expect.arrayContaining([
        'gmail-search-help',
        'gmail-safety-guidelines',
        'gmail-draft-reply',
        'gmail-attachment-workflow',
      ]),
    );
    await client.close();
  });

  it('returns static guidance text with no private data', async () => {
    const client = await connect(true);
    const result = await client.getPrompt({ name: 'gmail-safety-guidelines' });
    const text = result.messages
      .map((m) => (m.content.type === 'text' ? m.content.text : ''))
      .join('\n');
    expect(text).toMatch(/untrusted/i);
    // Generic guidance — no mailbox identity leaks into the template.
    expect(text).not.toContain('me@example.com');
    await client.close();
  });

  it('threads the draft-reply prompt arguments into the guidance', async () => {
    const client = await connect(true);
    const result = await client.getPrompt({
      name: 'gmail-draft-reply',
      arguments: { messageId: 'm777', instructions: 'be concise and friendly' },
    });
    const text = result.messages
      .map((m) => (m.content.type === 'text' ? m.content.text : ''))
      .join('\n');
    expect(text).toContain('m777');
    expect(text).toContain('be concise and friendly');
    expect(text).toContain('replyToMessageId');
    await client.close();
  });
});
