/**
 * Effective-config resolution (§10): defaults < home file < project file < env.
 *
 * Raw inputs are deep-merged in precedence order, then validated once (so schema
 * defaults fill any gaps), then `~`-expanded. Environment overrides use the
 * `GMAIL_MCP_` prefix with `_` as the nesting separator; segments are matched
 * case-insensitively against the schema's known keys. `GMAIL_MCP_LIVE_TESTS` is a
 * test-only variable with no config counterpart and is ignored (§10, §22.3).
 */

import fs from 'node:fs';
import os from 'node:os';
import { type AppResult, ok } from '../util/result.js';
import { appError } from '../mcp/errors.js';
import { type Config, defaultConfig, parseConfig } from './configSchema.js';
import { expandConfigPaths, homeConfigPath, projectConfigPath } from './paths.js';

const ENV_PREFIX = 'GMAIL_MCP_';

/** Env vars with the prefix that are NOT config keys and must be ignored (§10). */
const ENV_IGNORE = new Set(['GMAIL_MCP_LIVE_TESTS']);

export interface LoadConfigOptions {
  /** Home directory (defaults to `os.homedir()`). Injectable for tests. */
  home?: string;
  /** Working directory for the project-local override (defaults to `process.cwd()`). */
  cwd?: string;
  /** Environment to read overrides from (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively merge `source` over `target`; arrays and scalars are replaced. */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = out[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readJsonObjectIfExists(file: string): AppResult<Record<string, unknown> | undefined> {
  if (!fs.existsSync(file)) return ok(undefined);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: appError('internal_error', {
        message: `Failed to read config file ${file}: ${String(error)}`,
      }),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: appError('invalid_input', {
        message: `Config file ${file} is not valid JSON: ${String(error)}`,
      }),
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      error: appError('invalid_input', {
        message: `Config file ${file} must contain a JSON object.`,
      }),
    };
  }
  return ok(parsed);
}

/** Coerce an env string to the type of the matching default value. */
function coerceEnvValue(value: string, defaultValue: unknown): unknown {
  if (typeof defaultValue === 'boolean') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes' || v === 'on';
  }
  if (typeof defaultValue === 'number') {
    const n = Number(value);
    return Number.isNaN(n) ? value : n; // leave invalid as-is so the schema rejects it
  }
  if (Array.isArray(defaultValue)) {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return value;
}

/**
 * Resolve an env var's `_`-separated segments to an actual config key path by
 * walking the default config structure, matching each segment to a key
 * case-insensitively. Returns `null` for any segment that does not match.
 */
function resolveEnvPath(
  segments: string[],
  defaults: Record<string, unknown>,
): { path: string[]; defaultValue: unknown } | null {
  let node: unknown = defaults;
  const actualPath: string[] = [];
  for (const segment of segments) {
    if (!isPlainObject(node)) return null;
    const key = Object.keys(node).find((k) => k.toUpperCase() === segment.toUpperCase());
    if (key === undefined) return null;
    actualPath.push(key);
    node = node[key];
  }
  return { path: actualPath, defaultValue: node };
}

function setPath(obj: Record<string, unknown>, keyPath: string[], value: unknown): void {
  let node = obj;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const key = keyPath[i];
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keyPath[keyPath.length - 1]] = value;
}

/** Build the override object implied by `GMAIL_MCP_*` environment variables. */
function collectEnvOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const defaults = defaultConfig() as unknown as Record<string, unknown>;
  const overrides: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!name.startsWith(ENV_PREFIX)) continue;
    if (ENV_IGNORE.has(name)) continue;
    const segments = name.slice(ENV_PREFIX.length).split('_');
    const resolved = resolveEnvPath(segments, defaults);
    if (resolved === null) continue; // unknown key -> ignore (e.g. GMAIL_MCP_LIVE_TESTS)
    setPath(overrides, resolved.path, coerceEnvValue(value, resolved.defaultValue));
  }
  return overrides;
}

/**
 * Resolve the effective configuration from defaults, the home config file, the
 * project-local override, and environment variables (in increasing precedence).
 * Returns a validated, `~`-expanded `Config` or a canonical error.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppResult<Config> {
  const home = options.home ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  const homeRes = readJsonObjectIfExists(homeConfigPath(home));
  if (!homeRes.ok) return homeRes;
  const projectRes = readJsonObjectIfExists(projectConfigPath(cwd));
  if (!projectRes.ok) return projectRes;

  let raw: Record<string, unknown> = {};
  if (homeRes.value) raw = deepMerge(raw, homeRes.value);
  if (projectRes.value) raw = deepMerge(raw, projectRes.value);
  raw = deepMerge(raw, collectEnvOverrides(env));

  const parsed = parseConfig(raw);
  if (!parsed.ok) return parsed;
  return ok(expandConfigPaths(parsed.value, home));
}
