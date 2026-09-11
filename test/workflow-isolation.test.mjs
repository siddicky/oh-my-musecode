import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { WorkflowInterpreter } from '../dist/workflow/interpreter.js';

async function typeofInSandbox(code) {
  const interpreter = new WorkflowInterpreter();
  try {
    const response = await interpreter.evaluate('us005-probe', code);
    assert.equal(response.ok, true);
    return response.result;
  } finally {
    interpreter.disposeAll();
  }
}

test('require and process are unavailable', async () => {
  assert.equal(await typeofInSandbox(`typeof require;`), 'undefined');
  assert.equal(await typeofInSandbox(`typeof process;`), 'undefined');
});

test('network globals are unavailable', async () => {
  assert.equal(await typeofInSandbox(`typeof fetch;`), 'undefined');
  assert.equal(await typeofInSandbox(`typeof XMLHttpRequest;`), 'undefined');
});

test('wall-clock Date is unavailable without a time bridge', async () => {
  assert.equal(await typeofInSandbox(`typeof Date;`), 'undefined');
});

test('a bridged tool is the only way a capability appears', async () => {
  const interpreter = new WorkflowInterpreter({
    config: { ptc: { read_file: async (args) => `contents:${args.path}` } },
  });
  try {
    const response = await interpreter.evaluate(
      'us005-bridge',
      `await tools.readFile({ path: 'notes.txt' });`,
    );
    assert.equal(response.ok, true);
    assert.equal(response.result, 'contents:notes.txt');
  } finally {
    interpreter.disposeAll();
  }
});

test('skill docs carry the capability table and the approval warning', () => {
  const docs = readFileSync('skills/workflow/SKILL.md', 'utf8');
  for (const capability of [
    'JavaScript execution',
    'Top-level `await`',
    '`console.log`',
    'Agent tools',
    'Filesystem access',
    'Network access',
    'Wall-clock or datetime access',
    'Shell commands, package installs, OS execution',
  ]) {
    assert.ok(docs.includes(capability), `docs must table the "${capability}" capability`);
  }
  assert.ok(
    docs.includes('approval workflows are bypassed'),
    'docs must warn that PTC calls bypass per-call approval',
  );
});
