/**
 * Installer tests.
 *
 * Every invocation here MUST run against a throwaway XDG_CONFIG_HOME. An earlier
 * version of this file did not, so running `npm test` silently installed the
 * plugin into the developer's real muse config — eight skills plus hooks and an
 * MCP server. A test suite that mutates the machine it runs on is a defect, so
 * `runInstaller` refuses to run without an isolated config dir.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { runInstaller, withSandbox } from './helpers/install-sandbox.mjs';

test('install writes hooks and the mcp server into an isolated settings.json', () => {
  withSandbox('install', ({ workspace, configHome, settings }) => {
    const result = runInstaller(['install', '--workspace', workspace], { configHome });
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
  withSandbox('install', ({ workspace, configHome, settings }) => {
    assert.equal(runInstaller(['install', '--workspace', workspace], { configHome }).status, 0);
    const first = readFileSync(settings, 'utf8');

    const second = runInstaller(['install', '--workspace', workspace], { configHome });
    assert.equal(second.status, 0, second.output);
    assert.equal(readFileSync(settings, 'utf8'), first);
  });
});

test('--dry-run writes nothing at all', () => {
  withSandbox('install', ({ workspace, configHome, settings }) => {
    const result = runInstaller(['install', '--workspace', workspace, '--dry-run'], { configHome });
    assert.equal(result.status, 0, result.output);
    assert.ok(!existsSync(settings), 'dry run must not create settings.json');
    assert.match(result.output, /Would merge|would install/i);
  });
});

test('--dry-run leaves an existing settings.json byte-identical', () => {
  withSandbox('install', ({ workspace, configHome, settings }) => {
    runInstaller(['install', '--workspace', workspace], { configHome });
    const before = readFileSync(settings);

    const result = runInstaller(['install', '--workspace', workspace, '--dry-run'], { configHome });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(readFileSync(settings), before);
  });
});

test('install preserves the user’s own settings and hooks', () => {
  withSandbox('install', ({ workspace, configHome, settings }) => {
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

    assert.equal(runInstaller(['install', '--workspace', workspace], { configHome }).status, 0);

    const written = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(written.provider, 'meta', 'unrelated settings must survive');
    assert.equal(written.model, 'muse-spark-1.3');
    const commands = written.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(commands.includes('echo mine'), "the user's own hook must survive");
  });
});

test('install refuses to clobber a corrupt settings.json', () => {
  withSandbox('install', ({ workspace, configHome, settings }) => {
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, '{ not json');

    const result = runInstaller(['install', '--workspace', workspace], { configHome });

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
  withSandbox('install', ({ workspace, configHome }) => {
    const output = runInstaller(['install', '--workspace', workspace, '--dry-run'], { configHome }).output;
    assert.match(output, /Escalation preflight:/);
    // No profile is defined by default on 1.3.0 either (the live probe reports
    // `profile does not exist`), so scoping stays unavailable. If a build ever
    // ships a usable profile, update this deliberately rather than letting the
    // preflight quietly start claiming a capability it never re-checked.
    assert.match(output, /named permission profiles: no usable profile defined/);
  });
});

test('installer names both costs of the external critic, not just one', () => {
  withSandbox('install', ({ workspace, configHome }) => {
    // Collapse whitespace: the installer hard-wraps its prose, so line breaks land
    // in arbitrary places and must not decide whether this test passes.
    const output = runInstaller(['install', '--workspace', workspace, '--dry-run'], { configHome }).output.replace(
      /\s+/g,
      ' ',
    );
    assert.match(output, /--disable-sandbox/, 'must name the actual escalation route');
    assert.match(output, /EVERYTHING in the session/, 'must say the scope is session-wide');
    assert.match(output, /audit trail/, 'must say the critic falls outside the audit trail');
    assert.doesNotMatch(output, /omm-critic/, 'must not advertise a profile that cannot exist');
  });
});

test('installer falls back to muse settings when the build reports no plugins', () => {
  // The default fake simulates a plugins-off (≤1.1.1) build, so this covers
  // the legacy fallback route — not current-build behavior (see the
  // marketplace-route suite for that).
  withSandbox('install', ({ workspace, configHome }) => {
    const output = runInstaller(['install', '--workspace', workspace, '--dry-run'], { configHome }).output;
    assert.match(output, /plugins are not available/i);
    assert.match(output, /Delivery: muse settings/);
  });
});

test('installer rejects an unknown argument instead of ignoring it', () => {
  withSandbox('install', ({ configHome }) => {
    const result = runInstaller(['install', '--nonsense'], { configHome });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /unknown argument/);
  });
});

test('bare flags with no verb are rejected and point at install', () => {
  withSandbox('install', ({ configHome }) => {
    const result = runInstaller(['--workspace', '/tmp/whatever'], { configHome });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /a command is required/);
    assert.match(result.output, /install/, 'must suggest install as the command to run');
  });
});

test('an unknown verb is rejected', () => {
  withSandbox('install', ({ configHome }) => {
    const result = runInstaller(['frobnicate'], { configHome });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /unknown command "frobnicate"/);
    assert.match(result.output, /install, uninstall, doctor/);
  });
});

test('--help prints the bin name and all three verbs, no verb required', () => {
  withSandbox('install', ({ configHome }) => {
    const result = runInstaller(['--help'], { configHome });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Usage: oh-my-musecode <install\|uninstall\|doctor> \[options\]/);
    assert.match(result.output, /install\s+Install the harness: marketplace plugin route/);
    assert.match(result.output, /uninstall\s+Remove the installed harness: plugin record/);
    assert.match(result.output, /doctor\s+Verify hooks resolve/);
  });
});
