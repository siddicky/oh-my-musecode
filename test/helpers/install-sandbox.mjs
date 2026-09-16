/**
 * Shared installer test sandbox helpers.
 *
 * Every installer test spawns `node scripts/install.mjs` against an isolated
 * XDG_CONFIG_HOME and workspace, cleaned up afterward — never the developer's
 * real ~/.config/muse. An earlier version of this file did not isolate this
 * way, so running `npm test` silently installed the plugin into the
 * developer's real muse config — eight skills plus hooks and an MCP server.
 * A test suite that mutates the machine it runs on is a defect, so
 * `runInstaller` refuses to run without an isolated config dir.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const INSTALLER = join(ROOT, 'scripts', 'install.mjs');
const FAKE_MUSE = join(ROOT, 'test', 'helpers', 'fake-muse.mjs');

/** Environment for a deterministic Muse CLI backed by the isolated config. */
export function museTestEnv(configHome) {
  const binDir = join(configHome, 'test-bin');
  const launcher = join(binDir, 'muse');
  mkdirSync(binDir, { recursive: true });
  copyFileSync(FAKE_MUSE, launcher);
  chmodSync(launcher, 0o755);
  return {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };
}

/**
 * Runs the installer with a mandatory isolated config dir.
 * @param {string[]} args
 * @param {{ configHome: string, env?: Record<string,string> }} opts
 */
export function runInstaller(args, { configHome, env = {} } = {}) {
  if (!configHome) throw new Error('runInstaller requires an isolated configHome');
  const result = spawnSync('node', [INSTALLER, ...args], {
    encoding: 'utf8',
    env: { ...museTestEnv(configHome), ...env },
  });
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/**
 * A workspace plus an isolated muse config home, both removed afterwards.
 * `prefix` distinguishes leftover temp dirs by suite if cleanup is ever
 * interrupted (e.g. `omm-lifecycle-ws-...` vs `omm-harden-ws-...`).
 */
export function withSandbox(prefix, fn) {
  const workspace = mkdtempSync(join(tmpdir(), `omm-${prefix}-ws-`));
  const configHome = mkdtempSync(join(tmpdir(), `omm-${prefix}-cfg-`));
  try {
    return fn({
      workspace,
      configHome,
      settings: join(configHome, 'muse', 'settings.json'),
      env: museTestEnv(configHome),
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  }
}
