import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { WorkflowInterpreter } from '../dist/workflow/interpreter.js';

test('variables persist across eval calls in one session', async () => {
  const interpreter = new WorkflowInterpreter();
  try {
    const first = await interpreter.evaluate('us002-persist', 'globalThis.counter = 41; counter;');
    assert.equal(first.ok, true);
    const second = await interpreter.evaluate('us002-persist', 'globalThis.counter + 1;');
    assert.equal(second.ok, true);
    assert.equal(second.result, 42);
  } finally {
    interpreter.disposeAll();
  }
});

test('sessions do not share variables', async () => {
  const interpreter = new WorkflowInterpreter();
  try {
    await interpreter.evaluate('us002-a', 'globalThis.shared = "a-value";');
    const other = await interpreter.evaluate('us002-b', 'typeof globalThis.shared;');
    assert.equal(other.ok, true);
    assert.equal(other.result, 'undefined');
  } finally {
    interpreter.disposeAll();
  }
});

test('an infinite loop is terminated by executionTimeoutMs', async () => {
  const interpreter = new WorkflowInterpreter({ config: { executionTimeoutMs: 200 } });
  try {
    const response = await interpreter.evaluate('us002-timeout', 'while (true) {}');
    assert.equal(response.ok, false);
    assert.match(response.error ?? '', /timed out|interrupt/i);
  } finally {
    interpreter.disposeAll();
  }
});

test('allocating beyond memoryLimitBytes fails', async () => {
  const interpreter = new WorkflowInterpreter({ config: { memoryLimitBytes: 1024 * 1024 } });
  try {
    const response = await interpreter.evaluate(
      'us002-memory',
      `'x'.repeat(10 * 1024 * 1024).length;`,
    );
    assert.equal(response.ok, false);
    assert.match(response.error ?? '', /memory|allocat/i);
  } finally {
    interpreter.disposeAll();
  }
});

test('deep recursion beyond maxStackSizeBytes fails', async () => {
  const interpreter = new WorkflowInterpreter({ config: { maxStackSizeBytes: 16 * 1024 } });
  try {
    const response = await interpreter.evaluate(
      'us002-stack',
      'function f(n) { return f(n + 1); } f(0);',
    );
    assert.equal(response.ok, false);
    assert.match(response.error ?? '', /stack/i);
  } finally {
    interpreter.disposeAll();
  }
});

test('quickjs ships as pure WASM with no native build step', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.ok(pkg.dependencies['quickjs-emscripten'], 'quickjs-emscripten must be a dependency');
  for (const script of ['install', 'postinstall', 'preinstall']) {
    assert.equal(
      pkg.scripts?.[script],
      undefined,
      `package.json must declare no ${script} script that compiles quickjs`,
    );
  }
});

test('the installed quickjs package contains no native bindings', () => {
  const found = execFileSync('find', ['node_modules/quickjs-emscripten', '-name', '*.node'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(found, '', `expected no *.node bindings, found: ${found}`);
});
