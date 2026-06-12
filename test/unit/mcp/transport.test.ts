import { describe, it, expect } from 'vitest';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  createServerTransport,
  resolveHttpBinding,
  isLoopbackHost,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
} from '../../../src/mcp/transport.js';

describe('createServerTransport (§8.1)', () => {
  it('returns a stdio transport for kind=stdio', () => {
    expect(createServerTransport('stdio')).toBeInstanceOf(StdioServerTransport);
  });

  it('throws for kind=http (HTTP is started via serveHttp, not here)', () => {
    expect(() => createServerTransport('http')).toThrow(/serveHttp/);
  });
});

describe('isLoopbackHost (§8.2)', () => {
  it.each(['127.0.0.1', '127.0.0.5', '127.255.255.255', 'localhost', 'LOCALHOST', '::1', '[::1]'])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['0.0.0.0', '10.0.0.1', '192.168.1.50', '8.8.8.8', 'example.com', '::', ''])(
    'treats %s as non-loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe('resolveHttpBinding (§8.2)', () => {
  it('defaults to 127.0.0.1:3333 with no input', () => {
    const r = resolveHttpBinding();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ host: DEFAULT_HTTP_HOST, port: DEFAULT_HTTP_PORT });
  });

  it('exposes the §8.2 defaults', () => {
    expect(DEFAULT_HTTP_HOST).toBe('127.0.0.1');
    expect(DEFAULT_HTTP_PORT).toBe(3333);
  });

  it('accepts an explicit loopback host and numeric port', () => {
    const r = resolveHttpBinding({ host: '127.0.0.1', port: 3333 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ host: '127.0.0.1', port: 3333 });
  });

  it('accepts localhost and ::1', () => {
    expect(resolveHttpBinding({ host: 'localhost' }).ok).toBe(true);
    expect(resolveHttpBinding({ host: '::1' }).ok).toBe(true);
  });

  it('parses a string port', () => {
    const r = resolveHttpBinding({ port: '8080' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.port).toBe(8080);
  });

  it('allows port 0 (OS-assigned ephemeral port)', () => {
    const r = resolveHttpBinding({ port: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.port).toBe(0);
  });

  it('trims surrounding whitespace from the host', () => {
    const r = resolveHttpBinding({ host: '  127.0.0.1  ' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.host).toBe('127.0.0.1');
  });

  it.each(['0.0.0.0', '::', '[::]', '*', ''])('refuses wildcard host %s', (host) => {
    const r = resolveHttpBinding({ host });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_input');
      expect(r.error.message).toMatch(/wildcard/i);
    }
  });

  it.each(['10.0.0.1', '192.168.1.50', '8.8.8.8', 'example.com'])(
    'refuses non-loopback host %s and cites TLS/auth',
    (host) => {
      const r = resolveHttpBinding({ host });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('invalid_input');
        expect(r.error.message).toMatch(/non-loopback/i);
        expect(r.error.message).toMatch(/TLS/);
      }
    },
  );

  it.each(['abc', '12.5', '3333abc', '0x10'])('rejects malformed port "%s"', (port) => {
    const r = resolveHttpBinding({ port });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/port/i);
  });

  it.each(['', ' ', '   '])('falls back to the default port for blank port "%s"', (port) => {
    const r = resolveHttpBinding({ port });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.port).toBe(DEFAULT_HTTP_PORT);
  });

  it.each([-1, 70000, 65536])('rejects out-of-range port %s', (port) => {
    const r = resolveHttpBinding({ port });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/port/i);
  });
});
