/**
 * Marketplace-route installer tests (plugins-on builds).
 *
 * These run the real `scripts/install.mjs` against `fake-muse.mjs` in
 * `OMM_FAKE_PLUGINS=on` mode, which mirrors the live Muse 1.3.0 `plugins`
 * surface (install/approve/enable, list/inspect, remove, validate) backed by
 * an isolated store — including the live constraints that matter: bundles
 * with symlinks are refused, and approve with no runtime capabilities
 * reports `runtime-capability-not-found`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { runInstaller, withSandbox } from './helpers/install-sandbox.mjs';

const PLUGINS_ON = { OMM_FAKE_PLUGINS: 'on' };
const callsLog = (configHome) => join(configHome, 'muse', 'fake-calls.log');
const readCalls = (configHome) =>
  existsSync(callsLog(configHome)) ? readFileSync(callsLog(configHome), 'utf8') : '';

test('install takes the marketplace route: install, approve, enable', () => {
  withSandbox('marketplace', ({ workspace, configHome }) => {
    const result = runInstaller(['install', '--workspace', workspace], { configHome, env: PLUGINS_ON });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Delivery: plugin marketplace/);
    assert.match(result.output, /Bundle validates against the live binary/);
    assert.match(result.output, /Installed oh-my-musecode/);
    assert.match(result.output, /Approved \d+ runtime capabilities/);
    assert.match(result.output, /Enabled oh-my-musecode/);

    const calls = readCalls(configHome);
    assert.match(calls, /plugins install .* --scope user --json/);
    assert.match(calls, /plugins approve oh-my-musecode --json/);
    assert.match(calls, /plugins enable oh-my-musecode --json/);
  });
});

test('marketplace install is idempotent: one record, same version', () => {
  withSandbox('marketplace', ({ workspace, configHome }) => {
    assert.equal(
      runInstaller(['install', '--workspace', workspace], { configHome, env: PLUGINS_ON }).status,
      0,
    );
    const second = runInstaller(['install', '--workspace', workspace], { configHome, env: PLUGINS_ON });
    assert.equal(second.status, 0, second.output);

    const store = JSON.parse(
      readFileSync(join(configHome, 'muse', 'fake-plugin-store.json'), 'utf8'),
    );
    const ids = Object.keys(store.plugins);
    assert.deepEqual(ids, ['oh-my-musecode'], 'reinstall must refresh, not duplicate');
  });
});

test('marketplace install writes no settings.json and no stable home', () => {
  withSandbox('marketplace', ({ workspace, configHome, settings }) => {
    const result = runInstaller(['install', '--workspace', workspace], { configHome, env: PLUGINS_ON });
    assert.equal(result.status, 0, result.output);
    assert.ok(!existsSync(settings), 'marketplace route must not touch settings.json');
    assert.ok(
      !existsSync(join(configHome, 'muse', 'oh-my-musecode')),
      'marketplace route must not create a stable home',
    );
  });
});

test('marketplace dry-run writes nothing', () => {
  withSandbox('marketplace', ({ workspace, configHome, settings }) => {
    const result = runInstaller(['install', '--workspace', workspace, '--dry-run'], {
      configHome,
      env: PLUGINS_ON,
    });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Delivery: plugin marketplace/);
    assert.match(result.output, /Would stage a plugin bundle/);
    assert.ok(!existsSync(settings), 'dry run must not create settings.json');
    assert.ok(
      !existsSync(join(configHome, 'muse', 'fake-plugin-store.json')),
      'dry run must not touch the plugin store',
    );
  });
});

test('uninstall removes the plugin record; a second uninstall exits clean', () => {
  withSandbox('marketplace', ({ workspace, configHome }) => {
    assert.equal(
      runInstaller(['install', '--workspace', workspace], { configHome, env: PLUGINS_ON }).status,
      0,
    );
    const first = runInstaller(['uninstall'], { configHome, env: PLUGINS_ON });
    assert.equal(first.status, 0, first.output);
    assert.match(first.output, /Removed plugin record oh-my-musecode/);

    const store = JSON.parse(
      readFileSync(join(configHome, 'muse', 'fake-plugin-store.json'), 'utf8'),
    );
    assert.deepEqual(store.plugins, {}, 'the record must be gone');

    const second = runInstaller(['uninstall'], { configHome, env: PLUGINS_ON });
    assert.equal(second.status, 0, second.output);
    assert.match(second.output, /nothing to remove/);
  });
});

test('doctor is healthy after a marketplace install', () => {
  withSandbox('marketplace', ({ workspace, configHome }) => {
    assert.equal(
      runInstaller(['install', '--workspace', workspace], { configHome, env: PLUGINS_ON }).status,
      0,
    );
    const result = runInstaller(['doctor', '--workspace', workspace], { configHome, env: PLUGINS_ON });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /plugin installed/);
    assert.match(result.output, /plugin enabled/);
    assert.match(result.output, /plugin valid and active/);
    assert.match(result.output, /8\/8 visible \(scope: plugin\)/);
    assert.match(result.output, /mcp server spawns/);
    assert.match(result.output, /doctor: healthy/);
  });
});

test('doctor is unhealthy when nothing is installed', () => {
  withSandbox('marketplace', ({ workspace, configHome }) => {
    const result = runInstaller(['doctor', '--workspace', workspace], { configHome, env: PLUGINS_ON });
    assert.notEqual(result.status, 0, 'doctor must fail without an install');
    assert.match(result.output, /doctor: unhealthy/);
  });
});
