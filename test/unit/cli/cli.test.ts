import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, VERSION, type CliDeps } from '../../../src/cli.js';
import { parseConfig, defaultConfig } from '../../../src/config/configSchema.js';

let home: string;
let cwd: string;
let out: string[];
let err: string[];

function deps(extra: Partial<CliDeps> = {}): CliDeps {
  return {
    home,
    cwd,
    env: {},
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    ...extra,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-cli-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-cli-cwd-'));
  out = [];
  err = [];
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('help and version', () => {
  it('prints help listing every §20 command (no args)', async () => {
    const code = await runCli([], deps());
    expect(code).toBe(0);
    const text = out.join('\n');
    for (const cmd of [
      'auth login',
      'auth status',
      'auth logout',
      'auth revoke',
      'config init',
      'config show',
      'doctor',
      'start',
    ]) {
      expect(text).toContain(cmd);
    }
  });

  it('--help also prints help', async () => {
    expect(await runCli(['--help'], deps())).toBe(0);
    expect(out.join('\n')).toContain('Usage:');
  });

  it('--version prints the version', async () => {
    expect(await runCli(['--version'], deps())).toBe(0);
    expect(out.join('\n')).toContain(VERSION);
  });
});

describe('config init', () => {
  it('writes a valid §10 config to ~/.gmail-mcp/config.json', async () => {
    const code = await runCli(['config', 'init'], deps());
    expect(code).toBe(0);
    const file = path.join(home, '.gmail-mcp', 'config.json');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = parseConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(defaultConfig());
  });

  it('refuses to overwrite without --force, but --force overwrites', async () => {
    expect(await runCli(['config', 'init'], deps())).toBe(0);
    expect(await runCli(['config', 'init'], deps())).toBe(1);
    expect(err.join('\n')).toContain('--force');
    expect(await runCli(['config', 'init', '--force'], deps())).toBe(0);
  });
});

describe('config show', () => {
  it('prints the effective merged config as JSON', async () => {
    const code = await runCli(['config', 'show'], deps({ env: { GMAIL_MCP_TRANSPORT: 'http' } }));
    expect(code).toBe(0);
    const printed = JSON.parse(out.join('\n'));
    expect(printed.transport).toBe('http');
    // ~ has been expanded in the effective config.
    expect(printed.oauth.credentialsPath).not.toContain('~');
  });
});

describe('doctor (stub)', () => {
  it('reports node version and config validity', async () => {
    const code = await runCli(['doctor'], deps());
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('node version');
    expect(out.join('\n')).toContain('config: OK');
  });
});

describe('start', () => {
  it('selects stdio by default and delegates to the start hook', async () => {
    let kind: string | undefined;
    const code = await runCli(['start'], deps({ startHook: async (k) => ((kind = k), 0) }));
    expect(code).toBe(0);
    expect(kind).toBe('stdio');
  });

  it('honors --transport http via the hook', async () => {
    let kind: string | undefined;
    await runCli(
      ['start', '--transport', 'http'],
      deps({ startHook: async (k) => ((kind = k), 0) }),
    );
    expect(kind).toBe('http');
  });

  it('errors (without hanging) when http transport is requested for real', async () => {
    const code = await runCli(['start', '--transport', 'http'], deps());
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/HTTP transport is not implemented/);
  });
});

describe('unknown command and auth placeholder', () => {
  it('returns 1 for an unknown command', async () => {
    expect(await runCli(['frobnicate'], deps())).toBe(1);
  });

  it('auth subcommands are placeholders for now', async () => {
    expect(await runCli(['auth', 'status'], deps())).toBe(1);
  });
});
