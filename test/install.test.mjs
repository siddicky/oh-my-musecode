/**
 * Installer tests.
 *
 * Every invocation here MUST run against a throwaway XDG_CONFIG_HOME. An earlier
 * version of this file did not, so running `npm test` silently installed the
 * plugin into the developer's real muse config — seven skills plus hooks and an
 * MCP server. A test suite that mutates the machine it runs on is a defect, so
 * `runInstaller` refuses to run without an isolated config dir.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLER = join(ROOT, 'scripts', 'install.mjs');

/**
 * Runs the installer with a mandatory isolated config dir.
 * @param {string[]} args
 * @param {{ configHome: string, env?: Record<string,string> }} opts
 */
function runInstaller(args, { configHome, env = {} } = {}) {
  if (!configHome) throw new Error('runInstaller requires an isolated configHome');
  const result = spawnSync('node', [INSTALLER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: configHome, ...env },
  });
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** A workspace plus an isolated muse config home, both removed afterwards. */
function withSandbox(fn) {
  const workspace = mkdtempSync(join(tmpdir(), 'omm-install-ws-'));
  const configHome = mkdtempSync(join(tmpdir(), 'omm-install-cfg-'));
  try {
    return fn({ workspace, configHome, settings: join(configHome, 'muse', 'settings.json') });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  }
}

test('install writes hooks and the mcp server into an isolated settings.json', () => {
  withSandbox(({ workspace, configHome, settings }) => {
    const result = runInstaller(['--workspace', workspace], { configHome });
    assert.equal(result.status, 0, result.output);

    const written = JSON.parse(readFileSync(settings, 'utf8'));
    assert.deepEqual(Object.keys(written.hooks).sort(), [
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ]);
    assert.ok(written.mcpServers['omm-state'], 'the state server must be registered');
  });
});

test('install is idempotent', () => {
  withSandbox(({ workspace, configHome, settings }) => {
    assert.equal(runInstaller(['--workspace', workspace], { configHome }).status, 0);
    const first = readFileSync(settings, 'utf8');

    const second = runInstaller(['--workspace', workspace], { configHome });
    assert.equal(second.status, 0, second.output);
    assert.equal(readFileSync(settings, 'utf8'), first);
  });
});

test('--dry-run writes nothing at all', () => {
  withSandbox(({ workspace, configHome, settings }) => {
    const result = runInstaller(['--workspace', workspace, '--dry-run'], { configHome });
    assert.equal(result.status, 0, result.output);
    assert.ok(!existsSync(settings), 'dry run must not create settings.json');
    assert.match(result.output, /Would merge|would install/i);
  });
});

test('--dry-run leaves an existing settings.json byte-identical', () => {
  withSandbox(({ workspace, configHome, settings }) => {
    runInstaller(['--workspace', workspace], { configHome });
    const before = readFileSync(settings);

    const result = runInstaller(['--workspace', workspace, '--dry-run'], { configHome });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(readFileSync(settings), before);
  });
});

test('install preserves the user’s own settings and hooks', () => {
  withSandbox(({ workspace, configHome, settings }) => {
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        schema_version: 1,
        provider: 'meta',
        model: 'muse-spark-1.3',
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
      }),
    );

    assert.equal(runInstaller(['--workspace', workspace], { configHome }).status, 0);

    const written = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(written.provider, 'meta', 'unrelated settings must survive');
    assert.equal(written.model, 'muse-spark-1.3');
    const commands = written.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(commands.includes('echo mine'), "the user's own hook must survive");
  });
});

test('install refuses to clobber a corrupt settings.json', () => {
  withSandbox(({ workspace, configHome, settings }) => {
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, '{ not json');

    const result = runInstaller(['--workspace', workspace], { configHome });

    // The property that matters is that it refuses and preserves the file, not
    // which check catches it first. In practice a corrupt settings.json also
    // breaks muse's own probes, so the escalation preflight refuses on
    // "posture undetermined" before the JSON parse is ever reached — an earlier
    // and equally safe stop.
    assert.notEqual(result.status, 0, 'should refuse rather than overwrite');
    assert.match(result.output, /refusing to install|not valid JSON/);
    assert.equal(readFileSync(settings, 'utf8'), '{ not json', 'the corrupt file must be untouched');
  });
});

test('escalation preflight reports the real permission-profile capability', () => {
  withSandbox(({ workspace, configHome }) => {
    const output = runInstaller(['--workspace', workspace, '--dry-run'], { configHome }).output;
    assert.match(output, /Escalation preflight:/);
    // muse 1.0.3 cannot create named permission profiles. If a future build can,
    // update this deliberately rather than letting the preflight quietly start
    // claiming a capability it never re-checked.
    assert.match(output, /named permission profiles: unavailable on this build/);
  });
});

test('installer names both costs of the external critic, not just one', () => {
  withSandbox(({ workspace, configHome }) => {
    // Collapse whitespace: the installer hard-wraps its prose, so line breaks land
    // in arbitrary places and must not decide whether this test passes.
    const output = runInstaller(['--workspace', workspace, '--dry-run'], { configHome }).output.replace(
      /\s+/g,
      ' ',
    );
    assert.match(output, /--disable-sandbox/, 'must name the actual escalation route');
    assert.match(output, /EVERYTHING in the session/, 'must say the scope is session-wide');
    assert.match(output, /audit trail/, 'must say the critic falls outside the audit trail');
    assert.doesNotMatch(output, /omm-critic/, 'must not advertise a profile that cannot exist');
  });
});

test('installer explains that plugins are off on this build', () => {
  withSandbox(({ workspace, configHome }) => {
    const output = runInstaller(['--workspace', workspace, '--dry-run'], { configHome }).output;
    assert.match(output, /plugins are not available/i);
    assert.match(output, /Delivery: muse settings/);
  });
});

test('installer rejects an unknown argument instead of ignoring it', () => {
  withSandbox(({ configHome }) => {
    const result = runInstaller(['--nonsense'], { configHome });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /unknown argument/);
  });
});
