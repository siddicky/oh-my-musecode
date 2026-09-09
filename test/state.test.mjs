import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StateStore } from '../dist/state.js';
import { ProtectedPathError, EscapedStateRootError, resolveWritablePath } from '../dist/paths.js';

function withWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'omm-state-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('write then read round-trips inside .omm', () => {
  withWorkspace((dir) => {
    const store = new StateStore({ workspaceRoot: dir });
    store.write('state/ralph-state.json', '{"active":true}');
    assert.equal(store.read('state/ralph-state.json'), '{"active":true}');
    assert.ok(existsSync(join(dir, '.omm', 'state', 'ralph-state.json')));
  });
});

test('read returns null for an absent file', () => {
  withWorkspace((dir) => {
    assert.equal(new StateStore({ workspaceRoot: dir }).read('state/nope.json'), null);
  });
});

test('write creates nested directories under the root', () => {
  withWorkspace((dir) => {
    const store = new StateStore({ workspaceRoot: dir });
    store.write('specs/nested/deep/spec.md', '# spec');
    assert.equal(store.read('specs/nested/deep/spec.md'), '# spec');
  });
});

test('clear removes a file and no-ops when absent', () => {
  withWorkspace((dir) => {
    const store = new StateStore({ workspaceRoot: dir });
    store.write('state/tmp.json', '{}');
    assert.equal(store.clear('state/tmp.json'), true);
    assert.equal(store.clear('state/tmp.json'), false);
  });
});

test('writes targeting .agents/ are refused', () => {
  withWorkspace((dir) => {
    const store = new StateStore({ workspaceRoot: dir });
    assert.throws(
      () => store.write('../.agents/AGENTS.md', 'pwned'),
      (err) => err instanceof ProtectedPathError && /\.agents\// .test(err.message),
    );
    assert.ok(!existsSync(join(dir, '.agents')), 'no .agents directory should be created');
  });
});

test('writes targeting .muse/ are refused', () => {
  withWorkspace((dir) => {
    const store = new StateStore({ workspaceRoot: dir });
    assert.throws(() => store.write('../.muse/trust.json', '{}'), ProtectedPathError);
    assert.ok(!existsSync(join(dir, '.muse')));
  });
});

test('deep traversal to a protected path is refused', () => {
  withWorkspace((dir) => {
    const store = new StateStore({ workspaceRoot: dir });
    assert.throws(() => store.write('../../.agents/AGENTS.md', 'pwned'), ProtectedPathError);
    assert.throws(() => store.write('a/b/../../../.muse/x', 'pwned'), ProtectedPathError);
  });
});

test('escaping the state root without hitting a protected dir is still refused', () => {
  withWorkspace((dir) => {
    const store = new StateStore({ workspaceRoot: dir });
    assert.throws(() => store.write('../escaped.txt', 'nope'), EscapedStateRootError);
    assert.ok(!existsSync(join(dir, 'escaped.txt')));
  });
});

test('absolute paths outside the root are refused', () => {
  withWorkspace((dir) => {
    const store = new StateStore({ workspaceRoot: dir });
    assert.throws(() => store.write('/tmp/omm-absolute-escape.txt', 'nope'), EscapedStateRootError);
  });
});

test('a protected path reports the protected error, not the generic escape error', () => {
  withWorkspace((dir) => {
    // Both conditions hold for this path; the protected error is the useful one.
    assert.throws(
      () => resolveWritablePath(dir, '../../.agents/AGENTS.md'),
      ProtectedPathError,
    );
  });
});

test('a legitimately nested path that merely mentions .agents in a filename is allowed', () => {
  withWorkspace((dir) => {
    const store = new StateStore({ workspaceRoot: dir });
    // Segment matching, not substring matching: this is a filename, not a directory.
    store.write('notes/.agents-migration-notes.md', 'ok');
    assert.equal(store.read('notes/.agents-migration-notes.md'), 'ok');
  });
});
