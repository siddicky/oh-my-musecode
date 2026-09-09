import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  desiredHooks,
  desiredMcpServers,
  mergeSettings,
  unmergeSettings,
} from '../scripts/settings-install.mjs';

const ROOT = '/opt/oh-my-musecode';

/** Every hook entry in a settings document, flattened. */
const allHooks = (settings) =>
  Object.values(settings.hooks ?? {}).flatMap((groups) => groups.flatMap((g) => g.hooks ?? []));

test('no settings entry carries a field muse does not know', () => {
  // Regression: an `__owner` marker on each hook entry made muse reject the entry
  // and silently stop firing the hook — no diagnostic, it just never ran. Only
  // members muse recognises may appear.
  const allowedHookKeys = new Set(['type', 'command']);
  for (const hook of allHooks(mergeSettings(null, ROOT))) {
    for (const key of Object.keys(hook)) {
      assert.ok(allowedHookKeys.has(key), `hook carries unsupported key "${key}"`);
    }
  }

  const allowedServerKeys = new Set(['transport', 'command', 'args', 'env', 'url', 'headers']);
  for (const server of Object.values(desiredMcpServers(ROOT))) {
    for (const key of Object.keys(server)) {
      assert.ok(allowedServerKeys.has(key), `mcpServer carries unsupported key "${key}"`);
    }
  }
});

test('merge declares all three hook events', () => {
  const merged = mergeSettings(null, ROOT);
  assert.deepEqual(Object.keys(merged.hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit']);
  assert.equal(merged.schema_version, 1);
});

test('merge is idempotent and does not stack duplicate hooks', () => {
  const once = mergeSettings(null, ROOT);
  const twice = mergeSettings(once, ROOT);
  assert.deepEqual(twice, once);
  assert.equal(allHooks(twice).length, 3, 'exactly one hook per event');
});

test('merge preserves a user hook on the same event', () => {
  const existing = {
    schema_version: 1,
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
    },
  };
  const merged = mergeSettings(existing, ROOT);
  const commands = merged.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(commands.includes('echo mine'), "the user's own hook must survive");
  assert.equal(commands.length, 2);
});

test('merge preserves unrelated settings keys', () => {
  const existing = { schema_version: 1, provider: 'meta', model: 'muse-spark-1.3', tui: { x: 1 } };
  const merged = mergeSettings(existing, ROOT);
  assert.equal(merged.provider, 'meta');
  assert.equal(merged.model, 'muse-spark-1.3');
  assert.deepEqual(merged.tui, { x: 1 });
});

test('merge preserves an unrelated mcp server', () => {
  const existing = { mcpServers: { other: { transport: 'stdio', command: 'other' } } };
  const merged = mergeSettings(existing, ROOT);
  assert.ok(merged.mcpServers.other, 'a foreign server must survive');
  assert.ok(merged.mcpServers['omm-state']);
});

test('unmerge removes exactly our entries and nothing else', () => {
  const existing = {
    schema_version: 1,
    provider: 'meta',
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
    mcpServers: { other: { transport: 'stdio', command: 'other' } },
  };

  const restored = unmergeSettings(mergeSettings(existing, ROOT), ROOT);

  assert.equal(restored.provider, 'meta');
  assert.ok(restored.mcpServers.other);
  assert.ok(!restored.mcpServers?.['omm-state'], 'our server must be gone');

  const commands = (restored.hooks?.SessionStart ?? []).flatMap((g) => g.hooks.map((h) => h.command));
  assert.deepEqual(commands, ['echo mine'], "only the user's hook remains");
});

test('unmerge drops empty containers rather than leaving husks', () => {
  const restored = unmergeSettings(mergeSettings(null, ROOT), ROOT);
  assert.ok(!('hooks' in restored), 'empty hooks map should be removed');
  assert.ok(!('mcpServers' in restored), 'empty mcpServers map should be removed');
});

test('hook commands point at this plugin root', () => {
  for (const hook of allHooks({ hooks: desiredHooks(ROOT) })) {
    assert.match(hook.command, new RegExp(ROOT), 'command must be rooted at the plugin');
    assert.match(hook.command, /^node /);
  }
});

test('hook commands are shell-quoted against command substitution', () => {
  // Found in adversarial re-review: JSON.stringify is not shell quoting. Inside
  // double quotes a POSIX shell still expands $(...) and backticks, so a checkout
  // path alone was enough to get code execution when muse ran the hook.
  const hostile = '/tmp/$(touch /tmp/OMM_PWNED)/`id`/root';
  for (const group of Object.values(desiredHooks(hostile))) {
    for (const hook of group[0].hooks) {
      assert.doesNotMatch(hook.command, /"/, 'must not rely on double quotes');
      assert.match(hook.command, /^node '/, 'path must be single-quoted');
      // Single quotes suppress expansion, so the metacharacters survive literally.
      assert.ok(hook.command.includes('$(touch /tmp/OMM_PWNED)'));
    }
  }
});

test('a path containing a single quote is escaped, not broken', () => {
  const tricky = "/tmp/it's/root";
  const command = desiredHooks(tricky).SessionStart[0].hooks[0].command;
  assert.match(command, /'\\''/, "single quote must be closed, escaped and reopened");
});

test('merge refuses to clobber a foreign mcpServer sharing our id', () => {
  // merge and unmerge must agree on ownership: unmerge only removes an omm-state
  // entry pointing into this plugin, so merge silently replacing a foreign one
  // would destroy it unrecoverably.
  const existing = {
    mcpServers: { 'omm-state': { transport: 'stdio', command: 'someone-elses-server' } },
  };
  assert.throws(() => mergeSettings(existing, ROOT), /not ours|Refusing to overwrite/);
});

test('merge still updates our own mcpServer entry', () => {
  const once = mergeSettings(null, ROOT);
  const twice = mergeSettings(once, ROOT);
  assert.deepEqual(twice.mcpServers['omm-state'], once.mcpServers['omm-state']);
});
