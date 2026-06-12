import { describe, it, expect } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { ToolRegistry, type ToolContext, type ToolGate } from '../../src/mcp/toolRegistry.js';
import { gmailSendMessageTool } from '../../src/tools/gmailSendMessage.js';
import { buildToolGate } from '../../src/tools/gate.js';
import { GmailClient, type GmailApi } from '../../src/gmail/gmailClient.js';
import type { GmailSession } from '../../src/gmail/session.js';
import { defaultConfig } from '../../src/config/configSchema.js';
import type { Config } from '../../src/config/config.js';
import { createSilentLogger } from '../../src/util/logger.js';
import { Scope } from '../../src/auth/scopeProfiles.js';
import { CONFIRMATION_STRINGS } from '../../src/safety/confirmation.js';
import type { AuditLogger } from '../../src/audit/auditLogger.js';
import type { AuditEvent } from '../../src/audit/auditEvents.js';

interface Captured {
  sendBody?: { raw?: string };
  sendCalls: number;
}

function fakeSession(captured: Captured): GmailSession {
  const api = {
    users: {
      messages: {
        send: async (params: { requestBody?: Captured['sendBody'] }) => {
          captured.sendCalls += 1;
          captured.sendBody = params.requestBody;
          return { data: { id: 'sent-1', threadId: 'thr-1' } };
        },
      },
    },
  } as unknown as GmailApi;
  const gmail = new GmailClient(api, { retry: { sleep: async () => {}, random: () => 0 } });
  return { gmail, grantedScopes: [Scope.GmailSend] };
}

/** A config with the send feature toggled (defaults otherwise). */
function configWithSend(send: boolean, overrides: Partial<Config['safety']> = {}): Config {
  const base = defaultConfig();
  return {
    ...base,
    features: { ...base.features, send },
    safety: { ...base.safety, ...overrides },
  };
}

function capturingAudit(sink: AuditEvent[]): AuditLogger {
  return { record: (event) => sink.push(event) };
}

async function connect(context: ToolContext, gate: ToolGate): Promise<Client> {
  const registry = new ToolRegistry();
  registry.register(gmailSendMessageTool);
  const server = buildMcpServer({ registry, context, gate });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

async function clientFor(config: Config, captured: Captured, audit?: AuditLogger): Promise<Client> {
  const session = fakeSession(captured);
  return connect(
    { config, logger: createSilentLogger(), session, audit },
    buildToolGate(config, session.grantedScopes, true),
  );
}

describe('gmail_send_message (§12.13, §16.3, §16.5)', () => {
  it('returns feature_disabled when features.send is off (default)', async () => {
    const captured: Captured = { sendCalls: 0 };
    const client = await clientFor(configWithSend(false), captured);
    const result = await client.callTool({
      name: 'gmail_send_message',
      arguments: { to: ['a@example.com'], bodyText: 'x', confirmation: CONFIRMATION_STRINGS.send },
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe(
      'feature_disabled',
    );
    expect(captured.sendCalls).toBe(0);
    await client.close();
  });

  it('requires confirmation when requireConfirmationForSend (default)', async () => {
    const captured: Captured = { sendCalls: 0 };
    const client = await clientFor(configWithSend(true), captured);
    const result = await client.callTool({
      name: 'gmail_send_message',
      arguments: { to: ['a@example.com'], subject: 'Hi', bodyText: 'x' },
    });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { error: { code: string } }).error.code).toBe(
      'confirmation_required',
    );
    expect(captured.sendCalls).toBe(0);
    await client.close();
  });

  it('sends with the exact confirmation string and audits metadata but not the body', async () => {
    const captured: Captured = { sendCalls: 0 };
    const audit: AuditEvent[] = [];
    const client = await clientFor(configWithSend(true), captured, capturingAudit(audit));
    const result = await client.callTool({
      name: 'gmail_send_message',
      arguments: {
        to: ['a@example.com'],
        subject: 'Quarterly update',
        bodyText: 'secret body text',
        confirmation: CONFIRMATION_STRINGS.send,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      sentMessage: { id: 'sent-1', threadId: 'thr-1' },
    });
    expect(captured.sendCalls).toBe(1);

    const record = audit.find((e) => e.tool === 'gmail_send_message');
    expect(record?.status).toBe('sent');
    expect(record?.messageId).toBe('sent-1');
    expect(record?.subject).toBe('Quarterly update');
    // The body must never appear in the audit record (§16.5).
    expect(JSON.stringify(record)).not.toContain('secret body text');
    await client.close();
  });

  it('sends without confirmation when requireConfirmationForSend is false', async () => {
    const captured: Captured = { sendCalls: 0 };
    const client = await clientFor(
      configWithSend(true, { requireConfirmationForSend: false }),
      captured,
    );
    const result = await client.callTool({
      name: 'gmail_send_message',
      arguments: { to: ['a@example.com'], bodyText: 'x' },
    });
    expect(result.isError).toBeFalsy();
    expect(captured.sendCalls).toBe(1);
    await client.close();
  });
});
