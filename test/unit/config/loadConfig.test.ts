import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../../src/config/loadConfig.js';

let home: string;
let cwd: string;

function writeHomeConfig(obj: unknown): void {
  const dir = path.join(home, '.gmail-mcp');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(obj), 'utf8');
}

function writeProjectConfig(obj: unknown): void {
  fs.writeFileSync(path.join(cwd, '.gmail-mcp.json'), JSON.stringify(obj), 'utf8');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-cwd-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('loadConfig environment overrides', () => {
  it('GMAIL_MCP_TRANSPORT overrides transport', () => {
    const r = loadConfig({ home, cwd, env: { GMAIL_MCP_TRANSPORT: 'http' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.transport).toBe('http');
  });

  it('GMAIL_MCP_LOGGING_LEVEL=debug overrides logging.level', () => {
    const r = loadConfig({ home, cwd, env: { GMAIL_MCP_LOGGING_LEVEL: 'debug' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.logging.level).toBe('debug');
  });

  it('coerces nested boolean overrides (GMAIL_MCP_FEATURES_DRAFTS=true)', () => {
    const r = loadConfig({ home, cwd, env: { GMAIL_MCP_FEATURES_DRAFTS: 'true' } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.features.drafts).toBe(true);
      expect(r.value.features.search).toBe(true); // untouched default
    }
  });

  it('ignores unrelated and unknown GMAIL_MCP_ vars gracefully', () => {
    const r = loadConfig({ home, cwd, env: { GMAIL_MCP_NOT_A_KEY: 'x' } });
    expect(r.ok).toBe(true);
  });
});

describe('loadConfig file precedence', () => {
  it('project-local .gmail-mcp.json overrides the home config, merging other keys', () => {
    writeHomeConfig({ logging: { level: 'warn', auditLogPath: '~/home-audit.jsonl' } });
    writeProjectConfig({ logging: { level: 'error' } });
    const r = loadConfig({ home, cwd, env: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.logging.level).toBe('error'); // project wins
      // home-only key survives the deep merge (and is ~-expanded)
      expect(r.value.logging.auditLogPath).toBe(path.join(home, 'home-audit.jsonl'));
    }
  });

  it('environment overrides win over both files', () => {
    writeHomeConfig({ transport: 'stdio' });
    writeProjectConfig({ transport: 'stdio' });
    const r = loadConfig({ home, cwd, env: { GMAIL_MCP_TRANSPORT: 'http' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.transport).toBe('http');
  });
});

describe('loadConfig ~ expansion (§15.1)', () => {
  it('expands ~ for credentialsPath, tokenPath, and rootDir', () => {
    const r = loadConfig({ home, cwd, env: {} });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.oauth.credentialsPath).toBe(path.join(home, '.gmail-mcp', 'credentials.json'));
      expect(r.value.oauth.tokenPath).toBe(path.join(home, '.gmail-mcp', 'tokens', 'default.json'));
      expect(r.value.downloads.rootDir).toBe(path.join(home, 'Downloads', 'gmail-mcp'));
      expect(r.value.oauth.credentialsPath).not.toContain('~');
    }
  });
});

describe('loadConfig ignores GMAIL_MCP_LIVE_TESTS (§10, §22.3)', () => {
  it('does not appear in or mutate the effective config', () => {
    const baseline = loadConfig({ home, cwd, env: {} });
    const withLive = loadConfig({ home, cwd, env: { GMAIL_MCP_LIVE_TESTS: '1' } });
    expect(baseline.ok && withLive.ok).toBe(true);
    if (baseline.ok && withLive.ok) {
      expect(withLive.value).toEqual(baseline.value);
      expect(JSON.stringify(withLive.value)).not.toContain('LIVE_TESTS');
      expect(JSON.stringify(withLive.value)).not.toContain('liveTests');
    }
  });
});

describe('loadConfig error handling', () => {
  it('returns invalid_input for malformed JSON', () => {
    fs.writeFileSync(path.join(cwd, '.gmail-mcp.json'), '{ not json', 'utf8');
    const r = loadConfig({ home, cwd, env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });

  it('returns invalid_input for an out-of-range override', () => {
    const r = loadConfig({ home, cwd, env: { GMAIL_MCP_LIMITS_MAXPAGESIZE: '-3' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });
});
