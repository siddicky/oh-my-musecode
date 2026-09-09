import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { routePrompt, renderRoutingContext, ROUTES } from '../hooks/routing.mjs';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');

/** Runs a hook with a JSON payload on stdin, returning its stdout. */
function runHook(name, payload) {
  return execFileSync('node', [join(HOOKS, name)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

function withTempWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'omm-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('routePrompt matches every declared keyword', () => {
  for (const { skill, keywords } of ROUTES) {
    for (const keyword of keywords) {
      assert.ok(
        routePrompt(`please ${keyword} now`).includes(skill),
        `keyword "${keyword}" should route to ${skill}`,
      );
    }
  }
});

test('routePrompt stays silent on an unrelated prompt', () => {
  assert.deepEqual(routePrompt('what does this function return?'), []);
  assert.equal(renderRoutingContext([]), null);
});

test('routePrompt respects word boundaries', () => {
  // Substring matching would make "ralphie" fire ralph and "ethnography" fire
  // trace ("graph" contains no "trace", but "retrace"/"traced" would).
  assert.deepEqual(routePrompt('ralphie the dog'), []);
  assert.deepEqual(routePrompt('retraced our steps'), []);
  assert.ok(routePrompt('run ralph').includes('ralph'));
  assert.ok(routePrompt('trace this bug').includes('trace'));
});

test('routePrompt handles empty and non-string input', () => {
  assert.deepEqual(routePrompt(''), []);
  assert.deepEqual(routePrompt('   '), []);
  assert.deepEqual(routePrompt(undefined), []);
  assert.deepEqual(routePrompt(null), []);
});

test('routePrompt deduplicates and preserves ROUTES order', () => {
  const hits = routePrompt('ralph and ralph and deep-interview');
  assert.deepEqual(hits, ['deep-interview', 'ralph']);
});

test('UserPromptSubmit hook emits routing context on a keyword hit', () => {
  const out = runHook('user-prompt-submit.mjs', { prompt: 'lets run ralph on this' });
  const parsed = JSON.parse(out);
  assert.match(parsed.hookSpecificOutput.additionalContext, /\/ralph/);
  assert.match(parsed.hookSpecificOutput.additionalContext, /invoke-only/);
});

test('UserPromptSubmit hook emits nothing on a miss', () => {
  assert.equal(runHook('user-prompt-submit.mjs', { prompt: 'explain this regex' }).trim(), '');
});

test('UserPromptSubmit hook survives a malformed payload', () => {
  const out = execFileSync('node', [join(HOOKS, 'user-prompt-submit.mjs')], {
    input: 'not json at all',
    encoding: 'utf8',
  });
  assert.equal(out.trim(), '');
});

test('SessionStart hook creates the .omm state root', () => {
  withTempWorkspace((dir) => {
    const out = runHook('session-start.mjs', { cwd: dir });
    assert.ok(existsSync(join(dir, '.omm', 'state')), '.omm/state should exist');
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /initialised state root/);
  });
});

test('SessionStart hook never creates protected paths', () => {
  withTempWorkspace((dir) => {
    runHook('session-start.mjs', { cwd: dir });
    assert.ok(!existsSync(join(dir, '.agents')), '.agents must not be created');
    assert.ok(!existsSync(join(dir, '.muse')), '.muse must not be created');
  });
});

test('SessionStart hook is silent when the state root already exists', () => {
  withTempWorkspace((dir) => {
    runHook('session-start.mjs', { cwd: dir });
    assert.equal(runHook('session-start.mjs', { cwd: dir }).trim(), '');
  });
});

test('Stop hook reminds while a ralph run is active', () => {
  withTempWorkspace((dir) => {
    mkdirSync(join(dir, '.omm', 'state'), { recursive: true });
    writeFileSync(
      join(dir, '.omm', 'state', 'ralph-state.json'),
      JSON.stringify({ active: true, critic_mode: 'codex', current_story: 'US-004' }),
    );
    const context = JSON.parse(runHook('stop.mjs', { cwd: dir })).hookSpecificOutput
      .additionalContext;
    assert.match(context, /ralph run is still active/);
    assert.match(context, /US-004/);
    assert.match(context, /codex reviewer/);
  });
});

test('Stop hook stays silent with no state or an inactive run', () => {
  withTempWorkspace((dir) => {
    assert.equal(runHook('stop.mjs', { cwd: dir }).trim(), '');

    mkdirSync(join(dir, '.omm', 'state'), { recursive: true });
    writeFileSync(join(dir, '.omm', 'state', 'ralph-state.json'), JSON.stringify({ active: false }));
    assert.equal(runHook('stop.mjs', { cwd: dir }).trim(), '');
  });
});

test('Stop hook stays silent on corrupt state rather than crashing the turn', () => {
  withTempWorkspace((dir) => {
    mkdirSync(join(dir, '.omm', 'state'), { recursive: true });
    writeFileSync(join(dir, '.omm', 'state', 'ralph-state.json'), '{ not valid json');
    assert.equal(runHook('stop.mjs', { cwd: dir }).trim(), '');
  });
});

test('explicit slash invocations route, including /cancel', () => {
  // Every skill must be reachable by its slash form; `cancel` has no safe bare
  // keyword, so this is its only route.
  for (const { skill } of ROUTES) {
    assert.ok(
      routePrompt(`/${skill}`).includes(skill),
      `/${skill} should route to ${skill}`,
    );
  }
  assert.deepEqual(routePrompt('/cancel'), ['cancel']);
  assert.ok(routePrompt('please run /cancel now').includes('cancel'));
});

test('bare "cancel" is deliberately not routed', () => {
  // Cancellation discards in-flight state, and the bare word is far too common in
  // ordinary English to fire on. This is a deliberate exclusion, not an omission.
  assert.deepEqual(routePrompt('cancel that subscription'), []);
  assert.deepEqual(routePrompt('how do I cancel a promise?'), []);
  assert.deepEqual(routePrompt('cancel'), []);
});

test('slash matching does not fire on a path-like string', () => {
  assert.deepEqual(routePrompt('see src/cancel/notes.md'), []);
  assert.deepEqual(routePrompt('lib/ralph.js'), []);
});
