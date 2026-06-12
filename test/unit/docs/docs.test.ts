import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig } from '../../../src/config/configSchema.js';

const ROOT = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** The §24 published file set (exact). */
const PUBLISHED_FILES = [
  'README.md',
  'docs/hld/GMAIL_MCP_SERVER_HLD.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'LICENSE',
  '.env.example',
  'examples/config.readonly.json',
  'examples/config.modify.json',
  'examples/config.send.json',
  'examples/config.full.json',
  'examples/claude-code.mcp.json',
];

describe('published repository file set (§24)', () => {
  it('contains every required file', () => {
    for (const file of PUBLISHED_FILES) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} should exist`).toBe(true);
    }
  });
});

describe('README (§24, §21.1)', () => {
  const readme = read('README.md');

  it('states all six mandatory disclaimers', () => {
    expect(readme).toMatch(/not an official Google product/i);
    expect(readme).toMatch(/not an official Anthropic product/i);
    expect(readme).toMatch(/narrowest Gmail scopes/i);
    expect(readme).toMatch(/mail\.google\.com/);
    expect(readme).toMatch(/avoided unless/i);
    expect(readme).toMatch(/untrusted/i);
    expect(readme).toMatch(/prompt injection/i);
    expect(readme).toMatch(/review write\/send actions/i);
  });

  it('includes the §21.1 local-stdio setup steps', () => {
    expect(readme).toContain('npm install -g gmail-mcp-server');
    expect(readme).toContain('gmail-mcp-server config init');
    expect(readme).toContain('gmail-mcp-server auth login --scope-profile readonly');
    expect(readme).toContain('claude mcp add gmail -- gmail-mcp-server start --transport stdio');
  });
});

/** Walk the default config into the GMAIL_MCP_* env var names it supports (§10). */
function envVarNames(): string[] {
  const names: string[] = [];
  const walk = (node: unknown, segments: string[]): void => {
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const [key, value] of Object.entries(node)) {
        walk(value, [...segments, key]);
      }
    } else {
      names.push(`GMAIL_MCP_${segments.map((s) => s.toUpperCase()).join('_')}`);
    }
  };
  walk(defaultConfig(), []);
  return names;
}

describe('.env.example (§10, §24)', () => {
  const env = read('.env.example');

  it('documents every supported GMAIL_MCP_ config variable', () => {
    for (const name of envVarNames()) {
      expect(env, `${name} should be documented`).toContain(`${name}=`);
    }
  });

  it('documents the test-only GMAIL_MCP_LIVE_TESTS variable as not a config key', () => {
    expect(env).toMatch(/GMAIL_MCP_LIVE_TESTS/);
    expect(env).toMatch(/NOT a config key/i);
  });
});
