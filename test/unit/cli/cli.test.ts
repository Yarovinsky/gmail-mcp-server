import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runCli,
  VERSION,
  MIN_NODE_MAJOR,
  buildDoctorChecks,
  featureScopeMismatches,
  type CliDeps,
  type DoctorContext,
} from '../../../src/cli.js';
import { parseConfig, defaultConfig } from '../../../src/config/configSchema.js';
import { Scope } from '../../../src/auth/scopeProfiles.js';

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

describe('doctor (full §20 checks)', () => {
  function writeCredentials(): void {
    const credPath = path.join(home, '.gmail-mcp', 'credentials.json');
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    fs.writeFileSync(
      credPath,
      JSON.stringify({ installed: { client_id: 'a', client_secret: 'b' } }),
      'utf8',
    );
  }

  it('fails (exit 1) when OAuth credentials are missing, naming the gap', async () => {
    const code = await runCli(['doctor'], deps());
    expect(code).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('node');
    expect(text).toContain('config');
    expect(text).toContain('credentials');
    expect(text).toMatch(/FAIL/);
  });

  it('passes (exit 0, warnings only) once credentials exist but no token yet', async () => {
    writeCredentials();
    const code = await runCli(['doctor'], deps());
    expect(code).toBe(0);
    const text = out.join('\n');
    // Token is absent → a warning, not a failure.
    expect(text).toMatch(/WARN/);
    expect(text).toContain('auth login');
  });

  it('runs the full seven-point check list', async () => {
    writeCredentials();
    await runCli(['doctor'], deps());
    const text = out.join('\n');
    for (const name of [
      'node',
      'config',
      'credentials',
      'token',
      'scopes',
      'downloads',
      'feature-scopes',
    ]) {
      expect(text).toContain(name);
    }
  });
});

describe('buildDoctorChecks (pure §20 logic)', () => {
  const healthy: DoctorContext = {
    nodeVersion: `v${MIN_NODE_MAJOR + 4}.0.0`,
    config: defaultConfig(),
    credentialsExists: true,
    tokenExists: true,
    grantedScopes: [Scope.GmailReadonly],
    downloadRoot: { enabled: true, path: '/tmp/dl', exists: true, writable: true },
    featureScopeMismatches: [],
  };

  it('marks every check ok for a fully-configured context', () => {
    const checks = buildDoctorChecks(healthy);
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
    expect(checks.map((c) => c.name)).toEqual([
      'node',
      'config',
      'credentials',
      'token',
      'scopes',
      'downloads',
      'feature-scopes',
    ]);
  });

  it('fails the node check below the minimum major', () => {
    const checks = buildDoctorChecks({ ...healthy, nodeVersion: `v${MIN_NODE_MAJOR - 2}.0.0` });
    expect(checks.find((c) => c.name === 'node')?.status).toBe('fail');
  });

  it('short-circuits after an invalid config', () => {
    const checks = buildDoctorChecks({
      ...healthy,
      config: null,
      configError: 'bad value',
    });
    expect(checks.map((c) => c.name)).toEqual(['node', 'config']);
    expect(checks.find((c) => c.name === 'config')?.status).toBe('fail');
  });

  it('fails when credentials are missing and warns when no token', () => {
    const checks = buildDoctorChecks({
      ...healthy,
      credentialsExists: false,
      tokenExists: false,
      grantedScopes: null,
    });
    expect(checks.find((c) => c.name === 'credentials')?.status).toBe('fail');
    expect(checks.find((c) => c.name === 'token')?.status).toBe('warn');
    expect(checks.find((c) => c.name === 'feature-scopes')?.status).toBe('warn');
  });

  it('fails the downloads check when the root exists but is not writable', () => {
    const checks = buildDoctorChecks({
      ...healthy,
      downloadRoot: { enabled: true, path: '/root/locked', exists: true, writable: false },
    });
    expect(checks.find((c) => c.name === 'downloads')?.status).toBe('fail');
  });

  it('warns when enabled features are not authorized by granted scopes', () => {
    const checks = buildDoctorChecks({ ...healthy, featureScopeMismatches: ['search', 'profile'] });
    const fsCheck = checks.find((c) => c.name === 'feature-scopes');
    expect(fsCheck?.status).toBe('warn');
    expect(fsCheck?.detail).toContain('search');
  });
});

describe('featureScopeMismatches (§9.3)', () => {
  it('reports no mismatch when readonly authorizes all default-enabled features', () => {
    expect(featureScopeMismatches(defaultConfig(), [Scope.GmailReadonly])).toEqual([]);
  });

  it('flags every scoped enabled feature when no scope is granted', () => {
    const mismatches = featureScopeMismatches(defaultConfig(), []);
    expect(mismatches).toContain('search');
    expect(mismatches).toContain('profile');
    expect(mismatches).toContain('attachments');
    // Disabled-by-default write features are not enabled, so never reported.
    expect(mismatches).not.toContain('drafts');
    expect(mismatches).not.toContain('send');
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

  it('refuses (without hanging) to bind HTTP to the 0.0.0.0 wildcard (§8.2)', async () => {
    const code = await runCli(
      ['start', '--transport', 'http', '--host', '0.0.0.0', '--port', '3333'],
      deps(),
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/wildcard/i);
    expect(err.join('\n')).toMatch(/127\.0\.0\.1/);
  });

  it('refuses (without hanging) to bind HTTP to a non-loopback host (§8.2)', async () => {
    const code = await runCli(['start', '--transport', 'http', '--host', '192.168.1.50'], deps());
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/non-loopback/i);
    expect(err.join('\n')).toMatch(/TLS/);
  });

  it('rejects (without hanging) a malformed --port', async () => {
    const code = await runCli(['start', '--transport', 'http', '--port', 'abc'], deps());
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/port/i);
  });
});

describe('unknown command', () => {
  it('returns 1 for an unknown command', async () => {
    expect(await runCli(['frobnicate'], deps())).toBe(1);
  });
});

describe('auth wiring (§9.2, §9.4)', () => {
  function tokenFile(): string {
    return path.join(home, '.gmail-mcp', 'tokens', 'default.json');
  }

  it('auth status returns 1 (not_authenticated) when no token is stored', async () => {
    const code = await runCli(['auth', 'status'], deps());
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/auth login/);
  });

  it('auth login without credentials.json fails with a clear message', async () => {
    const code = await runCli(['auth', 'login'], deps());
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/credentials/i);
  });

  it('auth login with an unknown --scope-profile fails before touching the browser', async () => {
    // Provide a credentials.json so the failure is attributable to the bad profile.
    const credPath = path.join(home, '.gmail-mcp', 'credentials.json');
    fs.mkdirSync(path.dirname(credPath), { recursive: true });
    fs.writeFileSync(
      credPath,
      JSON.stringify({ installed: { client_id: 'a', client_secret: 'b' } }),
      'utf8',
    );
    const code = await runCli(['auth', 'login', '--scope-profile', 'bogus'], deps());
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/Unknown scope profile/);
  });

  it('auth logout removes the local token file and returns 0', async () => {
    const file = tokenFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ refresh_token: '1//x' }), 'utf8');
    expect(fs.existsSync(file)).toBe(true);

    const code = await runCli(['auth', 'logout'], deps());
    expect(code).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('auth revoke without credentials still removes the local token', async () => {
    const file = tokenFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ refresh_token: '1//x' }), 'utf8');

    const code = await runCli(['auth', 'revoke'], deps());
    expect(code).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects an unknown auth subcommand', async () => {
    expect(await runCli(['auth', 'frobnicate'], deps())).toBe(1);
  });
});
