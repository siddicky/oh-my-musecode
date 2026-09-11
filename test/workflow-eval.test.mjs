import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowInterpreter } from '../dist/workflow/interpreter.js';

test('eval runs a reduce and returns team totals', async () => {
  const interpreter = new WorkflowInterpreter();
  try {
    const response = await interpreter.evaluate(
      'us001-totals',
      `const rows = [{team:'alpha',score:8},{team:'beta',score:13},{team:'alpha',score:21}];
       rows.reduce((acc, row) => {
         acc[row.team] = (acc[row.team] ?? 0) + row.score;
         return acc;
       }, {});`,
    );
    assert.equal(response.ok, true);
    assert.deepEqual(response.result, { alpha: 29, beta: 13 });
  } finally {
    interpreter.disposeAll();
  }
});

test('eval supports top-level await', async () => {
  const interpreter = new WorkflowInterpreter();
  try {
    const response = await interpreter.evaluate('us001-await', 'await Promise.resolve(42)');
    assert.equal(response.ok, true);
    assert.equal(response.result, 42);
  } finally {
    interpreter.disposeAll();
  }
});

test('console output is captured, and captureConsole:false discards it', async () => {
  const capturing = new WorkflowInterpreter();
  const silent = new WorkflowInterpreter({ config: { captureConsole: false } });
  try {
    const kept = await capturing.evaluate(
      'us001-console',
      `console.log('out'); console.warn('warn'); console.error('err'); 1;`,
    );
    assert.equal(kept.ok, true);
    assert.deepEqual(kept.console, ['out', 'warn', 'err']);

    const dropped = await silent.evaluate('us001-console', `console.log('out'); 1;`);
    assert.equal(dropped.ok, true);
    assert.deepEqual(dropped.console, []);
  } finally {
    capturing.disposeAll();
    silent.disposeAll();
  }
});

test('an unserializable result falls back to text instead of throwing', async () => {
  const interpreter = new WorkflowInterpreter();
  try {
    const response = await interpreter.evaluate('us001-bigint', '10n;');
    assert.equal(response.ok, true);
    assert.equal(response.text, '10');
  } finally {
    interpreter.disposeAll();
  }
});

test('exported declarations evaluate and persist like plain ones', async () => {
  const interpreter = new WorkflowInterpreter();
  try {
    const first = await interpreter.evaluate('us001-export', 'export const x = 41;\nx + 1;');
    assert.equal(first.ok, true);
    assert.equal(first.result, 42);
    const second = await interpreter.evaluate('us001-export', 'x + 1;');
    assert.equal(second.ok, true);
    assert.equal(second.result, 42);
  } finally {
    interpreter.disposeAll();
  }
});

test('results longer than maxResultChars truncate to exactly that count', async () => {
  const interpreter = new WorkflowInterpreter({ config: { maxResultChars: 16 } });
  try {
    const response = await interpreter.evaluate('us001-truncate', `'abcdefghijklmnopqrstuvwxyz'`);
    assert.equal(response.ok, true);
    assert.equal(response.truncated, true);
    assert.equal(response.text.length, 16);
    assert.equal(response.text, 'abcdefghijklmnop');
  } finally {
    interpreter.disposeAll();
  }
});
