/**
 * Regression coverage for issues found during a codex critic review
 * (`ralph --critic codex`) of the stable-home installer. Each test here
 * reproduces the exact scenario the review found broken, so none of these
 * can silently regress:
 *
 *   - install.mjs required the MCP SDK to be resolvable even for `install`,
 *     `uninstall`, `--help`, and `--version` (it statically imported
 *     doctor.mjs, which imports the SDK) — so a freshly `npm pack`-extracted
 *     tarball, with no node_modules yet, could not even run `install --dry-run`.
 *   - Upgrading versions left the OLD version's settings.json entries stuck:
 *     its hooks were treated as "foreign" (preserved instead of replaced) and
 *     its omm-state mcp entry made mergeSettings refuse outright as an
 *     unrecognized naming conflict.
 *   - resolveDependencyClosure's depth-first walk let a transitive
 *     dependency's version claim the top-level hoist slot before the root's
 *     OWN direct dependency of the same name was ever examined, producing an
 *     unresolvable `node_modules/node_modules/<name>` destination.
 *   - doctor accepted any existing file merely containing "hooks/" in its
 *     path, and any command mcp server was configured to spawn, without
 *     verifying either was actually inside the installed stable home — so a
 *     stale, foreign, or spoofed settings.json could be reported healthy.
 *   - uninstall discovered ownership only by listing directories still
 *     present on disk, so a stable home already deleted (by hand, or by a
 *     prior interrupted uninstall) left its settings.json entries with no
 *     way to be cleaned up.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolveDependencyClosure } from '../scripts/stable-home.mjs';
import { ROOT, runInstaller, withSandbox } from './helpers/install-sandbox.mjs';

test('resolveDependencyClosure: a root-level dependency wins the top-level hoist slot over a conflicting transitive one', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'omm-synth-deps-'));
  try {
    // root depends directly on x@2.0.0, and on a@1.0.0 which itself depends
    // on a DIFFERENT x@1.0.0 — a real, if unusual, npm tree shape.
    mkdirSync(join(scratch, 'node_modules', 'a', 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(scratch, 'node_modules', 'x'), { recursive: true });
    writeFileSync(
      join(scratch, 'package.json'),
      JSON.stringify({ name: 'root', version: '1.0.0', dependencies: { a: '1.0.0', x: '2.0.0' } }),
    );
    writeFileSync(
      join(scratch, 'node_modules', 'a', 'package.json'),
      JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { x: '1.0.0' } }),
    );
    writeFileSync(
      join(scratch, 'node_modules', 'a', 'node_modules', 'x', 'package.json'),
      JSON.stringify({ name: 'x', version: '1.0.0' }),
    );
    writeFileSync(join(scratch, 'node_modules', 'x', 'package.json'), JSON.stringify({ name: 'x', version: '2.0.0' }));

    const entries = resolveDependencyClosure(scratch);
    const byPath = Object.fromEntries(entries.map((e) => [e.destSegments.join('/'), e]));

    assert.equal(byPath['x']?.version, '2.0.0', "root's own x requirement must win the top-level slot");
    assert.equal(
      byPath['a/node_modules/x']?.version,
      '1.0.0',
      "a's conflicting x must nest under a's own node_modules, not the root's",
    );
    assert.ok(
      !entries.some((e) => e.destSegments[0] === 'node_modules'),
      'no entry may land under a bare node_modules/node_modules/<name> — that path is not resolvable by Node at all',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a packed-and-extracted tarball (no node_modules yet) can still run install --dry-run and --help', () => {
  const packDir = mkdtempSync(join(tmpdir(), 'omm-harden-pack-'));
  try {
    const packResult = JSON.parse(
      execFileSync('npm', ['pack', '--pack-destination', packDir, '--json'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, npm_config_dry_run: 'false' },
      }),
    );
    const tgzName = packResult[0].filename;
    const extractDir = join(packDir, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['-xzf', join(packDir, tgzName), '-C', extractDir]);
    const pkgDir = join(extractDir, 'package');

    withSandbox('harden', ({ workspace, configHome, env }) => {
      const helpResult = spawnSync('node', [join(pkgDir, 'scripts', 'install.mjs'), '--help'], {
        encoding: 'utf8',
      });
      assert.equal(helpResult.status, 0, `${helpResult.stdout}${helpResult.stderr}`);
      assert.match(helpResult.stdout, /Usage: oh-my-musecode/);

      const dryRunResult = spawnSync(
        'node',
        [join(pkgDir, 'scripts', 'install.mjs'), 'install', '--workspace', workspace, '--dry-run'],
        { encoding: 'utf8', env },
      );
      assert.equal(
        dryRunResult.status,
        0,
        `install --dry-run must work from a bare extracted tarball with no node_modules:\n${dryRunResult.stdout}${dryRunResult.stderr}`,
      );
      assert.doesNotMatch(dryRunResult.stderr, /ERR_MODULE_NOT_FOUND/);
    });
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
});

test('upgrading versions migrates settings.json away from the old stable home and prunes its directory', () => {
  withSandbox('harden', ({ workspace, configHome, settings }) => {
    const oldHome = join(configHome, 'muse', 'oh-my-musecode', '0.0.1-fake-old');
    mkdirSync(join(oldHome, 'hooks'), { recursive: true });
    writeFileSync(join(oldHome, 'hooks', 'session-start.mjs'), '#!/usr/bin/env node\n');
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        schema_version: 1,
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: `node '${join(oldHome, 'hooks', 'session-start.mjs')}'` }] },
          ],
        },
        mcpServers: {
          'omm-state': { transport: 'stdio', command: 'node', args: [join(oldHome, 'dist', 'mcp', 'state-server.js')] },
        },
      }),
    );

    const result = runInstaller(['install', '--workspace', workspace], { configHome });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Migrating away from 1 older install/);

    const written = JSON.parse(readFileSync(settings, 'utf8'));
    const sessionStartCommands = written.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(
      !sessionStartCommands.some((c) => c.includes(oldHome)),
      'the old version hook must be gone, not preserved as foreign',
    );
    assert.equal(sessionStartCommands.length, 1, 'exactly the new hook must remain, no duplicate');
    assert.ok(!written.mcpServers['omm-state'].args[0].includes(oldHome), 'the mcp entry must point at the new version');

    const homeParentEntries = readdirSync(join(configHome, 'muse', 'oh-my-musecode'));
    assert.deepEqual(homeParentEntries, ['0.2.0'], 'the old version directory must be pruned after a successful install');
  });
});

test('doctor rejects a hook path that exists but sits outside any verified install', () => {
  withSandbox('harden', ({ workspace, configHome, settings }) => {
    assert.equal(runInstaller(['install', '--workspace', workspace], { configHome }).status, 0);

    const foreignDir = mkdtempSync(join(tmpdir(), 'omm-harden-foreign-'));
    mkdirSync(join(foreignDir, 'hooks'), { recursive: true });
    writeFileSync(join(foreignDir, 'hooks', 'session-start.mjs'), '#!/usr/bin/env node\n');

    try {
      const written = JSON.parse(readFileSync(settings, 'utf8'));
      written.hooks.SessionStart = [
        { hooks: [{ type: 'command', command: `node '${join(foreignDir, 'hooks', 'session-start.mjs')}'` }] },
      ];
      writeFileSync(settings, JSON.stringify(written, null, 2) + '\n');

      const result = runInstaller(['doctor', '--workspace', workspace], { configHome });
      assert.notEqual(result.status, 0, 'doctor must fail when a configured hook points outside any verified install');
      assert.match(result.output, /doctor: unhealthy/);
      assert.match(result.output, /SessionStart/);
    } finally {
      rmSync(foreignDir, { recursive: true, force: true });
    }
  });
});

test('doctor refuses to spawn an mcp server entry pointing outside any verified install', () => {
  withSandbox('harden', ({ workspace, configHome, settings }) => {
    assert.equal(runInstaller(['install', '--workspace', workspace], { configHome }).status, 0);

    const written = JSON.parse(readFileSync(settings, 'utf8'));
    written.mcpServers['omm-state'].args[0] = join(ROOT, 'dist', 'mcp', 'state-server.js');
    writeFileSync(settings, JSON.stringify(written, null, 2) + '\n');

    const result = runInstaller(['doctor', '--workspace', workspace], { configHome });
    assert.notEqual(result.status, 0, 'doctor must refuse a spoofed/foreign mcp entry rather than spawn it');
    assert.match(result.output, /refusing to spawn/);
    assert.doesNotMatch(result.output, /responded, \d+ tools/, 'must not have actually spawned the foreign server');
  });
});

test('doctor refuses to spawn when the mcp "command" itself is swapped, even with a legitimate entry-point path', () => {
  // Found by a codex critic review's own adversarial probe: containment on
  // args[0] alone is not enough. `command` is the actual program spawned,
  // with args[0] passed to IT as a mere argument — so a settings.json where
  // `command` is swapped for something else, while args[0] still points at
  // the real, verified entry point, would make an earlier version of this
  // check pass containment and then run whatever `command` actually names.
  withSandbox('harden', ({ workspace, configHome, settings }) => {
    assert.equal(runInstaller(['install', '--workspace', workspace], { configHome }).status, 0);

    const marker = join(configHome, 'spawned-marker');
    const evilScript = join(configHome, 'not-node.sh');
    writeFileSync(evilScript, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
    execFileSync('chmod', ['+x', evilScript]);

    const written = JSON.parse(readFileSync(settings, 'utf8'));
    written.mcpServers['omm-state'].command = evilScript; // args[0] left pointing at the real, verified entry point
    writeFileSync(settings, JSON.stringify(written, null, 2) + '\n');

    const result = runInstaller(['doctor', '--workspace', workspace], { configHome });
    assert.notEqual(result.status, 0, 'doctor must refuse when command is not "node"');
    assert.match(result.output, /refusing to spawn/);
    assert.match(result.output, /not the "node" this installer always writes/);

    assert.ok(!existsSync(marker), 'the swapped command must never actually run');
  });
});

test('uninstall cleans settings.json even after the stable home directory is already gone', () => {
  withSandbox('harden', ({ workspace, configHome, settings }) => {
    assert.equal(runInstaller(['install', '--workspace', workspace], { configHome }).status, 0);

    rmSync(join(configHome, 'muse', 'oh-my-musecode'), { recursive: true, force: true });
    const beforeUninstall = JSON.parse(readFileSync(settings, 'utf8'));
    assert.ok(beforeUninstall.mcpServers?.['omm-state'], 'settings.json still references the now-deleted install');

    const result = runInstaller(['uninstall'], { configHome });
    assert.equal(result.status, 0, result.output);

    const written = JSON.parse(readFileSync(settings, 'utf8'));
    assert.ok(!written.mcpServers?.['omm-state'], 'the stale mcp entry must be removed even though its directory was already gone');
    assert.ok(!written.hooks?.SessionStart?.length, 'the stale hooks must be removed too');
  });
});
