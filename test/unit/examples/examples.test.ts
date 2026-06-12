import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig } from '../../../src/config/configSchema.js';
import { featureScopeMismatches } from '../../../src/cli.js';

const EXAMPLES_DIR = path.resolve(process.cwd(), 'examples');

function readJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, name), 'utf8'));
}

const VARIANTS = [
  'config.readonly.json',
  'config.modify.json',
  'config.send.json',
  'config.full.json',
] as const;

describe('example config variants (§10, §7.2)', () => {
  it('each variant validates against the config schema', () => {
    for (const name of VARIANTS) {
      const result = parseConfig(readJson(name));
      expect(result.ok, `${name} should be valid`).toBe(true);
    }
  });

  it("each variant's enabled features are authorized by its own scopes (no mismatch)", () => {
    for (const name of VARIANTS) {
      const result = parseConfig(readJson(name));
      if (!result.ok) throw new Error(`${name} invalid`);
      expect(featureScopeMismatches(result.value, result.value.oauth.scopes), name).toEqual([]);
    }
  });

  it('the four variants differ ONLY in oauth.scopes and features', () => {
    const baseline = parseConfig(readJson('config.readonly.json'));
    if (!baseline.ok) throw new Error('readonly invalid');
    for (const name of VARIANTS) {
      const parsed = parseConfig(readJson(name));
      if (!parsed.ok) throw new Error(`${name} invalid`);
      // Overlay the baseline's scopes + features; everything else must already match.
      const normalized = {
        ...parsed.value,
        oauth: { ...parsed.value.oauth, scopes: baseline.value.oauth.scopes },
        features: baseline.value.features,
      };
      expect(normalized, `${name} differs only in scopes/features`).toEqual(baseline.value);
    }
  });

  it('declares the expected scopes and feature flags per variant', () => {
    const readonly = parseConfig(readJson('config.readonly.json'));
    const modify = parseConfig(readJson('config.modify.json'));
    const send = parseConfig(readJson('config.send.json'));
    const full = parseConfig(readJson('config.full.json'));
    if (!readonly.ok || !modify.ok || !send.ok || !full.ok) throw new Error('invalid example');

    expect(readonly.value.oauth.scopes).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
    expect(readonly.value.features.send).toBe(false);
    expect(readonly.value.features.modify).toBe(false);

    expect(modify.value.oauth.scopes).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(modify.value.features.modify).toBe(true);
    expect(modify.value.features.labelsWrite).toBe(true);
    expect(modify.value.features.send).toBe(false);

    expect(send.value.oauth.scopes).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(send.value.features.send).toBe(true);
    expect(send.value.features.modify).toBe(false);

    expect(full.value.oauth.scopes).toEqual(['https://mail.google.com/']);
    expect(Object.values(full.value.features).every((v) => v === true)).toBe(true);
  });
});

describe('claude-code.mcp.json (§21.2)', () => {
  it('matches the §21.2 project config exactly', () => {
    expect(readJson('claude-code.mcp.json')).toEqual({
      mcpServers: {
        gmail: {
          command: 'gmail-mcp-server',
          args: ['start', '--transport', 'stdio'],
        },
      },
    });
  });
});
