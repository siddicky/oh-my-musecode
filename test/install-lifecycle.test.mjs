/**
 * End-to-end lifecycle coverage for the installer: real (non-dry-run) install,
 * uninstall, --purge, and doctor, all against a throwaway XDG_CONFIG_HOME and a
 * real `muse` subprocess — never the developer's real ~/.config/muse.
 *
 * See test/install.test.mjs for the argument-parsing and settings-merge unit
 * coverage; this file is the "does the whole thing actually work" layer:
 * the stable home is a self-contained copy (own node_modules, loadable with
 * the source repo unreachable), settings.json points into it, and doctor's
 * real MCP handshake genuinely passes/fails with the install's real state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ROOT, runInstaller, withSandbox } from './helpers/install-sandbox.mjs';

const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const SKILL_IDS = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

/** Lists muse skills scoped to `configHome`, returning the ids visible under --source user. */
function listUserSkillIds(configHome) {
  const result = spawnSync('muse', ['skills', 'list', '--source', 'user', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
  });
  assert.equal(result.status, 0, `muse skills list failed: ${result.stdout}${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  return new Set((parsed.skills ?? []).map((s) => s.id ?? s.name));
}

/** The stable home path an install at `configHome` writes for the repo's current version. */
function stableHomeOf(configHome) {
  return join(configHome, 'muse', 'oh-my-musecode', PKG_VERSION);
}

test('install copies the runtime into a versioned stable home with the manifest', () => {
  withSandbox('lifecycle', ({ workspace, configHome }) => {
    const result = runInstaller(['install', '--workspace', workspace], { configHome });
    assert.equal(result.status, 0, result.output);

    const home = stableHomeOf(configHome);
    for (const entry of ['hooks', 'dist', 'personas', 'node_modules']) {
      assert.ok(existsSync(join(home, entry)), `${entry} must exist under the stable home`);
    }

    const manifestPath = join(home, '.install.json');
    assert.ok(existsSync(manifestPath), '.install.json must be written');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.version, PKG_VERSION);
    assert.deepEqual([...manifest.copiedEntries].sort(), ['dist', 'hooks', 'personas']);
  });
});

test('settings.json hook commands and the mcp server args point into the stable home, not the repo', () => {
  withSandbox('lifecycle', ({ workspace, configHome, settings }) => {
    assert.equal(runInstaller(['install', '--workspace', workspace], { configHome }).status, 0);

    const home = stableHomeOf(configHome);
    const written = JSON.parse(readFileSync(settings, 'utf8'));

    for (const event of ['SessionStart', 'Stop', 'UserPromptSubmit']) {
      const commands = written.hooks[event].flatMap((g) => g.hooks.map((h) => h.command));
      assert.ok(commands.length > 0, `${event} must have at least one hook`);
      for (const command of commands) {
        assert.ok(command.includes(home), `${event} hook must point into the stable home: ${command}`);
        assert.ok(!command.includes(ROOT), `${event} hook must not point at the repo root: ${command}`);
      }
    }

    const mcpArgs = written.mcpServers['omm-state'].args;
    assert.ok(mcpArgs[0].startsWith(home), `mcp server entry must point into the stable home: ${mcpArgs[0]}`);
    assert.ok(!mcpArgs[0].startsWith(ROOT), `mcp server entry must not point at the repo root: ${mcpArgs[0]}`);
  });
});

test('install is idempotent at the stable-home root: no duplicate hook groups, byte-identical settings', () => {
  withSandbox('lifecycle', ({ workspace, configHome, settings }) => {
    assert.equal(runInstaller(['install', '--workspace', workspace], { configHome }).status, 0);
    const first = readFileSync(settings, 'utf8');
    const firstWritten = JSON.parse(first);
    for (const event of ['SessionStart', 'Stop', 'UserPromptSubmit']) {
      assert.equal(firstWritten.hooks[event].length, 1, `${event} must have exactly one hook group`);
    }

    const second = runInstaller(['install', '--workspace', workspace], { configHome });
    assert.equal(second.status, 0, second.output);
    assert.equal(readFileSync(settings, 'utf8'), first, 'settings.json must be byte-identical on reinstall');

    const secondWritten = JSON.parse(readFileSync(settings, 'utf8'));
    for (const event of ['SessionStart', 'Stop', 'UserPromptSubmit']) {
      assert.equal(secondWritten.hooks[event].length, 1, `${event} must still have exactly one hook group`);
    }
  });
});

test('the copied stable home resolves its own dependencies with the source node_modules unreachable', () => {
  withSandbox('lifecycle', ({ workspace, configHome }) => {
    assert.equal(runInstaller(['install', '--workspace', workspace], { configHome }).status, 0);

    const entry = join(stableHomeOf(configHome), 'dist', 'mcp', 'state-server.js');
    assert.ok(existsSync(entry));

    // cwd is a tmpdir outside the repo tree entirely, so Node's node_modules
    // resolution walking up from the imported file can never reach the repo's
    // node_modules by accident — only the stable home's own copy can satisfy it.
    const outsideCwd = mkdtempSync(join(tmpdir(), 'omm-lifecycle-outside-'));
    try {
      const result = spawnSync(
        process.execPath,
        ['-e', `import(${JSON.stringify('file://' + entry)}).then(() => console.log('IMPORT_OK')).catch((e) => { console.error(e.stack); process.exit(1); })`],
        { cwd: outsideCwd, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /IMPORT_OK/);
    } finally {
      rmSync(outsideCwd, { recursive: true, force: true });
    }
  });
});

test('uninstall removes our settings entries and the stable home, but not a foreign entry', () => {
  withSandbox('lifecycle', ({ workspace, configHome, settings }) => {
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        schema_version: 1,
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
        mcpServers: { 'someone-elses-server': { transport: 'stdio', command: 'node', args: ['/opt/other/server.js'] } },
      }),
    );

    assert.equal(runInstaller(['install', '--workspace', workspace], { configHome }).status, 0);
    const home = stableHomeOf(configHome);
    assert.ok(existsSync(home), 'stable home must exist after install');

    const result = runInstaller(['uninstall'], { configHome });
    assert.equal(result.status, 0, result.output);

    const written = JSON.parse(readFileSync(settings, 'utf8'));
    const sessionStartCommands = (written.hooks?.SessionStart ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(!sessionStartCommands.some((c) => c.includes(home)), 'our hook must be removed');
    assert.ok(sessionStartCommands.includes('echo mine'), "the foreign hook must survive untouched");
    assert.ok(!written.mcpServers?.['omm-state'], 'our mcp server entry must be removed');
    assert.deepEqual(
      written.mcpServers['someone-elses-server'],
      { transport: 'stdio', command: 'node', args: ['/opt/other/server.js'] },
      'the foreign mcp server entry must be byte-for-byte untouched',
    );

    assert.ok(!existsSync(home), 'the stable home directory must be deleted');
  });
});

test('uninstall --purge removes the 7 installed skills', () => {
  withSandbox('lifecycle', ({ workspace, configHome }) => {
    assert.equal(runInstaller(['install', '--workspace', workspace], { configHome }).status, 0);

    const installedIds = listUserSkillIds(configHome);
    for (const id of SKILL_IDS) {
      assert.ok(installedIds.has(id), `${id} should be installed before purge`);
    }

    const result = runInstaller(['uninstall', '--purge'], { configHome });
    assert.equal(result.status, 0, result.output);

    const afterIds = listUserSkillIds(configHome);
    for (const id of SKILL_IDS) {
      assert.ok(!afterIds.has(id), `${id} should be removed after --purge`);
    }
  });
});

test('doctor on a healthy install exits 0 and reports every check passing', () => {
  withSandbox('lifecycle', ({ workspace, configHome }) => {
    assert.equal(runInstaller(['install', '--workspace', workspace], { configHome }).status, 0);

    const result = runInstaller(['doctor', '--workspace', workspace], { configHome });
    assert.equal(result.status, 0, result.output);

    for (const name of [
      'settings.json',
      'hooks registered',
      'hook files resolve',
      'mcp server registered',
      'mcp server spawns',
      'skills visible',
    ]) {
      const line = result.output
        .split('\n')
        .find((l) => l.includes(name));
      assert.ok(line, `doctor output must mention "${name}": ${result.output}`);
      assert.ok(line.includes('✓'), `"${name}" must be reported as passing: ${line}`);
    }
    assert.match(result.output, /doctor: healthy/);
  });
});

test('doctor after uninstall exits non-zero and names a specific failed check', () => {
  withSandbox('lifecycle', ({ workspace, configHome }) => {
    assert.equal(runInstaller(['install', '--workspace', workspace], { configHome }).status, 0);
    assert.equal(runInstaller(['uninstall'], { configHome }).status, 0);

    const result = runInstaller(['doctor', '--workspace', workspace], { configHome });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /doctor: unhealthy/);
    assert.match(
      result.output,
      /✗ (hooks registered|hook files resolve|mcp server registered|mcp server spawns|skills visible)/,
      `must name at least one specific failed check: ${result.output}`,
    );
  });
});

test('doctor with no settings.json at all exits non-zero without throwing', () => {
  withSandbox('lifecycle', ({ workspace, configHome }) => {
    const result = runInstaller(['doctor', '--workspace', workspace], { configHome });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /settings\.json/);
    assert.match(result.output, /not found/);
    assert.match(result.output, /doctor: unhealthy/);
    assert.doesNotMatch(result.output, /at file:\/\//, 'must not print a raw stack trace');
  });
});
