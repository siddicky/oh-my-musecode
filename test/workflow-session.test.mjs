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

test('a timeout with an in-flight tool call drops cleanly without aborting', async () => {
  const interpreter = new WorkflowInterpreter({
    config: {
      executionTimeoutMs: 100,
      ptc: {
        slow: async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return 'late';
        },
      },
    },
  });
  try {
    const response = await interpreter.evaluate('us002-timeout-inflight', 'await tools.slow({});');
    assert.equal(response.ok, false);
    assert.match(response.error ?? '', /timed out/);
    // Let the late continuation fire; it must safely skip the dropped session.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const next = await interpreter.evaluate('us002-timeout-inflight', '40 + 2;');
    assert.equal(next.ok, true);
    assert.equal(next.result, 42);
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

test('concurrent evaluates on one session stay isolated', async () => {
  const interpreter = new WorkflowInterpreter({
    config: {
      ptc: {
        slow: async (args) => {
          await new Promise((resolve) => setTimeout(resolve, Number(args.ms ?? 0)));
          return 'done';
        },
      },
    },
  });
  try {
    // Warm up so both contenders share one live session instead of each
    // creating its own.
    await interpreter.evaluate('us002-race', '1;');
    const [first, second] = await Promise.all([
      interpreter.evaluate(
        'us002-race',
        `await tools.slow({ ms: 60 }); console.log('from-first'); 'first';`,
      ),
      interpreter.evaluate('us002-race', `console.log('from-second'); 'second';`),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.result, 'first');
    assert.equal(second.result, 'second');
    assert.deepEqual(first.console, ['from-first']);
    assert.deepEqual(second.console, ['from-second']);
  } finally {
    interpreter.disposeAll();
  }
});

test('a failed module load is retried instead of cached forever', async () => {
  const { getQuickJS } = await import('quickjs-emscripten');
  let attempts = 0;
  const interpreter = new WorkflowInterpreter({
    moduleLoader: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('wasm unavailable');
      return getQuickJS();
    },
  });
  try {
    await assert.rejects(interpreter.evaluate('us002-retry', '40 + 2;'), /wasm unavailable/);
    const response = await interpreter.evaluate('us002-retry', '40 + 2;');
    assert.equal(response.ok, true);
    assert.equal(response.result, 42);
    assert.equal(attempts, 2);
  } finally {
    interpreter.disposeAll();
  }
});

test('the installed quickjs package contains no native bindings', () => {
  const found = execFileSync('find', ['node_modules/quickjs-emscripten', '-name', '*.node'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(found, '', `expected no *.node bindings, found: ${found}`);
});
