/**
 * Regression tests for the symlink escape found in adversarial review.
 *
 * Lexical containment alone let `.omm/link -> <outside>` pass every string check
 * while resolving outside the state root, so an MCP caller could read, overwrite
 * or delete workspace-external files. Each case below is one of the reproductions
 * from that review.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StateStore } from '../dist/state.js';
import { SymlinkTraversalError, SymlinkedStateRootError } from '../dist/paths.js';

function withWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'omm-symlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'omm-outside-'));
  mkdirSync(join(dir, '.omm', 'state'), { recursive: true });
  try {
    return fn({ workspace: dir, outside, store: new StateStore({ workspaceRoot: dir }) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

test('a symlink out of .omm cannot be written through', () => {
  withWorkspace(({ workspace, outside, store }) => {
    symlinkSync(outside, join(workspace, '.omm', 'link'));

    assert.throws(() => store.write('link/pwn.txt', 'pwned'), SymlinkTraversalError);
    assert.ok(!existsSync(join(outside, 'pwn.txt')), 'nothing may be written outside the root');
  });
});

test('a symlink into a protected directory cannot be written through', () => {
  withWorkspace(({ workspace, store }) => {
    mkdirSync(join(workspace, '.agents'), { recursive: true });
    symlinkSync(join(workspace, '.agents'), join(workspace, '.omm', 'out'));

    assert.throws(() => store.write('out/AGENTS.md', 'pwned'), SymlinkTraversalError);
    assert.ok(!existsSync(join(workspace, '.agents', 'AGENTS.md')));
  });
});

test('clear cannot delete an external file through a symlink', () => {
  withWorkspace(({ workspace, outside, store }) => {
    const victim = join(outside, 'important.txt');
    writeFileSync(victim, 'keep me');
    symlinkSync(outside, join(workspace, '.omm', 'link'));

    assert.throws(() => store.clear('link/important.txt'), SymlinkTraversalError);
    assert.equal(readFileSync(victim, 'utf8'), 'keep me', 'external file must survive');
  });
});

test('read cannot follow a symlink out of the root', () => {
  withWorkspace(({ workspace, outside, store }) => {
    writeFileSync(join(outside, 'secret.txt'), 'classified');
    symlinkSync(outside, join(workspace, '.omm', 'link'));

    assert.throws(() => store.read('link/secret.txt'), SymlinkTraversalError);
  });
});

test('an intermediate symlinked directory is refused, not just the final component', () => {
  withWorkspace(({ workspace, outside, store }) => {
    mkdirSync(join(outside, 'nested'), { recursive: true });
    symlinkSync(outside, join(workspace, '.omm', 'mid'));

    assert.throws(() => store.write('mid/nested/deep.txt', 'pwned'), SymlinkTraversalError);
    assert.ok(!existsSync(join(outside, 'nested', 'deep.txt')));
  });
});

test('ordinary nested writes still work when no symlink is involved', () => {
  withWorkspace(({ store }) => {
    store.write('state/nested/ok.json', '{}');
    assert.equal(store.read('state/nested/ok.json'), '{}');
  });
});

test('a filename beginning with .. is allowed inside the root', () => {
  // `rel.startsWith('..')` used to reject this valid name.
  withWorkspace(({ store }) => {
    store.write('..notes.md', 'valid');
    assert.equal(store.read('..notes.md'), 'valid');
  });
});

test('a symlinked .omm root is refused outright, not followed', () => {
  // Found in adversarial re-review. realpath()ing the root before checking it
  // relocated every operation into the link target: `.omm -> external` yielded a
  // complete external read/write/delete primitive while every other check passed.
  const workspace = mkdtempSync(join(tmpdir(), 'omm-rootlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'omm-rootlink-ext-'));
  try {
    symlinkSync(outside, join(workspace, '.omm'));
    const store = new StateStore({ workspaceRoot: workspace });

    assert.throws(() => store.write('state/root-pwn', 'PWN'), SymlinkedStateRootError);
    assert.ok(!existsSync(join(outside, 'state', 'root-pwn')), 'nothing may be written outside');

    assert.throws(() => store.read('state/anything'), SymlinkedStateRootError);
    assert.throws(() => store.clear('state/anything'), SymlinkedStateRootError);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
