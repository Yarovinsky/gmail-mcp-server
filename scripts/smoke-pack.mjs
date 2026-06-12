/**
 * Package smoke test (HLD §23 item 6, §26.6).
 *
 * Packs the publishable tarball, installs it into a throwaway project exactly as a
 * fresh user would, and verifies the `gmail-mcp-server` bin is wired up and runs:
 *   - the npm-generated bin shim exists;
 *   - the installed entry prints the expected version;
 *   - `--help` mentions the tool.
 *
 * Cross-platform (Node only) so it runs identically in CI and on a developer machine.
 * Run via `npm run smoke`.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Unscoped package -> tarball name is deterministic; do not rely on parsing stdout
// (a prepack build banner could otherwise pollute it).
if (pkg.name.startsWith('@')) {
  throw new Error('smoke-pack assumes an unscoped package name; update tarball naming.');
}
const tarballName = `${pkg.name}-${pkg.version}.tgz`;

/** Invoke npm via the same executable that launched this script (robust on Windows). */
function npm(args, opts = {}) {
  const cli = process.env.npm_execpath;
  if (cli) {
    return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...opts });
  }
  const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return execFileSync(bin, args, { encoding: 'utf8', ...opts });
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-smoke-'));
const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-mcp-pack-'));
const tarballAbs = path.join(packDir, tarballName);

try {
  console.log(`Packing ${tarballName} (prepack will build dist/)...`);
  npm(['pack', '--pack-destination', packDir], { cwd: root, stdio: 'inherit' });
  if (!fs.existsSync(tarballAbs)) {
    throw new Error(`Expected tarball not produced: ${tarballAbs}`);
  }

  console.log(`Installing the tarball into a throwaway project at ${work}...`);
  npm(['init', '-y'], { cwd: work, stdio: 'ignore' });
  npm(['install', tarballAbs], { cwd: work, stdio: 'ignore' });

  // 1. The npm-generated bin shim must exist (proves the `bin` field is wired).
  const binDir = path.join(work, 'node_modules', '.bin');
  const shimExists =
    fs.existsSync(path.join(binDir, 'gmail-mcp-server')) ||
    fs.existsSync(path.join(binDir, 'gmail-mcp-server.cmd'));
  if (!shimExists) {
    throw new Error(`bin shim not found in ${binDir}`);
  }

  // 2. The installed entry runs and reports the expected version.
  const entry = path.join(work, 'node_modules', pkg.name, 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    throw new Error(`Published entry missing from the tarball: ${entry}`);
  }
  const version = execFileSync(process.execPath, [entry, '--version'], {
    encoding: 'utf8',
  }).trim();
  console.log(`Installed bin reports version: ${version}`);
  if (version !== pkg.version) {
    throw new Error(`Version mismatch: bin said "${version}", package.json says "${pkg.version}".`);
  }

  // 3. `--help` mentions the tool.
  const help = execFileSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
  if (!help.includes('gmail-mcp-server')) {
    throw new Error('`--help` output did not mention gmail-mcp-server.');
  }

  console.log('Package smoke test passed.');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(packDir, { recursive: true, force: true });
}
