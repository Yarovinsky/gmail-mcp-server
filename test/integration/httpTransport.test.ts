import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { serveHttp, type HttpServerHandle } from '../../src/mcp/transport.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import { createToolRegistry } from '../../src/tools/index.js';
import { defaultConfig } from '../../src/config/configSchema.js';
import { createSilentLogger } from '../../src/util/logger.js';

/** Build a fresh MCP server backed by the real tool registry (health is always on). */
function buildServer(): ReturnType<typeof buildMcpServer> {
  return buildMcpServer({
    registry: createToolRegistry(),
    context: { config: defaultConfig(), logger: createSilentLogger() },
  });
}

let handle: HttpServerHandle | undefined;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
});

/** Start the local HTTP transport on an ephemeral loopback port and return its base URL. */
async function startServer(): Promise<URL> {
  handle = await serveHttp(buildServer, { host: '127.0.0.1', port: 0 });
  const addr = handle.address();
  expect(addr).not.toBeNull();
  return new URL(`http://127.0.0.1:${addr!.port}/`);
}

async function connectClient(url: URL): Promise<Client> {
  const client = new Client({ name: 'test-http-client', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

describe('HTTP transport (§8.2)', () => {
  it('binds to 127.0.0.1 and serves a full MCP session', async () => {
    const url = await startServer();
    expect(handle!.address()!.host).toBe('127.0.0.1');

    const client = await connectClient(url);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('health');

    const result = await client.callTool({ name: 'health', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      status: 'ok',
      server: 'gmail-mcp-server',
    });

    await client.close();
  });

  it('supports a client disconnecting and a new client reconnecting (stateful sessions)', async () => {
    const url = await startServer();

    const first = await connectClient(url);
    expect((await first.listTools()).tools.length).toBeGreaterThan(0);
    await first.close();

    const second = await connectClient(url);
    const result = await second.callTool({ name: 'health', arguments: {} });
    expect(result.isError).toBeFalsy();
    await second.close();
  });

  it('rejects requests carrying a foreign Host header (DNS-rebinding protection)', async () => {
    await startServer();
    const port = handle!.address()!.port;

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            // Spoofed Host header — what a DNS-rebinding attack would send.
            host: 'evil.example.com',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'attacker', version: '0.0.0' },
          },
        }),
      );
    });

    expect(status).toBe(403);
  });

  it('rejects a non-initialize request that has no session (400)', async () => {
    await startServer();
    const port = handle!.address()!.port;

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            host: `127.0.0.1:${port}`,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
    });

    expect(status).toBe(400);
  });
});
