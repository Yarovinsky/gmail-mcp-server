/**
 * MCP transport selection (HLD §8). The default and recommended transport is stdio
 * (§8.1); an optional, local-only HTTP transport (§8.2) is also provided. Keeping
 * transport construction here isolates the SDK transport classes from the rest of the
 * code (the `gmail`/`auth`/`attachments` layers never see them).
 *
 * §8.2 invariants enforced here:
 *   - the default HTTP bind address is `127.0.0.1`, never `0.0.0.0`;
 *   - binding to a wildcard or any non-loopback host is refused, because remote HTTP
 *     would require TLS and authentication, which v1 does not implement;
 *   - DNS-rebinding protection is enabled and scoped to the loopback host we bound to,
 *     so a malicious web page cannot drive the local server through the browser.
 *
 * The HTTP transport runs in the SDK's stateful mode: each client `initialize` mints a
 * session-scoped transport (and a fresh MCP server) tracked in a session map, so a
 * client may disconnect and reconnect without restarting the process.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { TransportKind } from '../config/config.js';
import { appError } from './errors.js';
import { ok, err, type AppResult } from '../util/result.js';

export type { Transport };

/** Default HTTP bind host (§8.2: must be loopback, never `0.0.0.0`). */
export const DEFAULT_HTTP_HOST = '127.0.0.1';
/** Default HTTP port (§8.2 example). */
export const DEFAULT_HTTP_PORT = 3333;

/** A validated HTTP binding (always a loopback host and an in-range port). */
export interface HttpBinding {
  host: string;
  port: number;
}

/** Raw, possibly-undefined host/port as supplied on the CLI or in config. */
export interface HttpBindingInput {
  host?: string | undefined;
  port?: string | number | undefined;
}

/**
 * Whether `host` names the loopback interface. Covers `localhost`, the whole
 * `127.0.0.0/8` IPv4 block, and the IPv6 loopback (`::1`, optionally bracketed).
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === 'localhost') return true;
  if (h === '::1' || h === '[::1]') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Whether `host` is a "bind to every interface" wildcard. */
function isWildcardHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '' || h === '0.0.0.0' || h === '::' || h === '[::]' || h === '*';
}

/**
 * Resolve and validate an HTTP host/port, applying the §8.2 defaults and refusing any
 * non-loopback bind. Pure and fully unit-testable; the actual listener lives in
 * {@link serveHttp}.
 */
export function resolveHttpBinding(input: HttpBindingInput = {}): AppResult<HttpBinding> {
  const host = (input.host ?? DEFAULT_HTTP_HOST).trim();

  if (isWildcardHost(host)) {
    return err(
      appError('invalid_input', {
        message:
          `Refusing to bind HTTP to a wildcard address ("${host || '(empty)'}"). ` +
          `The HTTP transport is local-only; use 127.0.0.1 (§8.2).`,
      }),
    );
  }
  if (!isLoopbackHost(host)) {
    return err(
      appError('invalid_input', {
        message:
          `Refusing to bind HTTP to non-loopback host "${host}". Remote HTTP would require ` +
          `TLS and authentication, which this server does not implement; use 127.0.0.1 (§8.2).`,
      }),
    );
  }

  let port: number;
  if (input.port === undefined) {
    port = DEFAULT_HTTP_PORT;
  } else if (typeof input.port === 'number') {
    port = input.port;
  } else {
    // A missing/whitespace-only port string falls back to the default; otherwise it must
    // be plain decimal digits (rejecting `0x10`, `12.5`, `3e3`, signs, and `Number(' ')`'s
    // surprising coercion to 0).
    const trimmed = input.port.trim();
    if (trimmed === '') {
      port = DEFAULT_HTTP_PORT;
    } else if (!/^\d+$/.test(trimmed)) {
      return err(
        appError('invalid_input', {
          message: `Invalid --port "${input.port}": expected an integer between 1 and 65535.`,
        }),
      );
    } else {
      port = Number(trimmed);
    }
  }
  // Port 0 is permitted (asks the OS for an ephemeral port — used by tests); a negative
  // or out-of-range port is rejected.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return err(
      appError('invalid_input', {
        message: `Invalid port ${port}: expected an integer between 1 and 65535.`,
      }),
    );
  }

  return ok({ host, port });
}

/** The minimal server surface {@link serveHttp} needs (satisfied by `McpServer`). */
export interface ConnectableServer {
  connect(transport: Transport): Promise<void>;
}

/** A running local HTTP transport: the listener plus its lifecycle controls. */
export interface HttpServerHandle {
  readonly httpServer: http.Server;
  /** The actually-bound host/port (resolves port 0 to the OS-assigned port). */
  address(): { host: string; port: number } | null;
  /** Number of currently-tracked MCP sessions. */
  sessionCount(): number;
  /** Stop accepting connections and tear down every active session. */
  close(): Promise<void>;
}

/** The loopback `host:port` forms accepted in the `Host` header for `port`. */
function loopbackAllowedHosts(port: number): string[] {
  return [...new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `::1:${port}`])];
}

function netAddress(server: http.Server): { host: string; port: number } | null {
  const addr = server.address() as AddressInfo | string | null;
  if (addr && typeof addr === 'object') {
    return { host: addr.address, port: addr.port };
  }
  return null;
}

function writeJsonRpcError(res: http.ServerResponse, status: number, message: string): void {
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json' });
  }
  if (!res.writableEnded) {
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
  }
}

/** Buffer and JSON-parse a request body. Returns `undefined` for an empty body. */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return undefined;
  return JSON.parse(raw) as unknown;
}

/**
 * Start a local HTTP listener for the MCP server and connect it. Each `initialize`
 * request creates a session-scoped {@link StreamableHTTPServerTransport} (with
 * DNS-rebinding protection scoped to the loopback `Host` headers for the port we actually
 * bound to) and a fresh server from `createServer`; later requests are routed by their
 * `Mcp-Session-Id`. Transports are built only after the socket is listening so that, with
 * an ephemeral port (`port: 0`), the allow-list carries the real port.
 */
export async function serveHttp(
  createServer: () => ConnectableServer,
  binding: HttpBinding,
): Promise<HttpServerHandle> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  // Populated once the socket is listening (it needs the real, possibly-ephemeral port).
  let allowedHosts: string[] = loopbackAllowedHosts(binding.port);

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }

    // No live session for this request. Only a POSTed `initialize` may open one.
    if (req.method !== 'POST') {
      writeJsonRpcError(res, 400, 'No active MCP session; send an initialize request first.');
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      writeJsonRpcError(res, 400, 'Parse error: request body is not valid JSON.');
      return;
    }
    if (!isInitializeRequest(body)) {
      writeJsonRpcError(res, 400, 'No active MCP session; send an initialize request first.');
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts,
      onsessioninitialized: (sid) => {
        transports.set(sid, transport);
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) transports.delete(sid);
    };
    await createServer().connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      writeJsonRpcError(res, 500, 'Internal server error.');
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      httpServer.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      httpServer.removeListener('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(binding.port, binding.host);
  });

  const actualPort = netAddress(httpServer)?.port ?? binding.port;
  allowedHosts = loopbackAllowedHosts(actualPort);

  return {
    httpServer,
    address: () => netAddress(httpServer),
    sessionCount: () => transports.size,
    close: async () => {
      await Promise.all([...transports.values()].map((t) => t.close().catch(() => undefined)));
      transports.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/**
 * Create the server-side transport for a non-HTTP kind. The HTTP transport is not a
 * single `Transport` object (it owns an HTTP listener and a session map), so it is
 * started via {@link serveHttp} instead and reaching this function with `'http'` is a
 * programmer error.
 */
export function createServerTransport(kind: TransportKind): Transport {
  switch (kind) {
    case 'stdio':
      return new StdioServerTransport();
    case 'http':
      throw new Error('Use serveHttp() for the HTTP transport, not createServerTransport().');
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown transport: ${String(exhaustive)}`);
    }
  }
}
