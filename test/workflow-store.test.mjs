import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StateStore } from '../dist/state.js';
import {
  deleteWorkflow,
  listWorkflows,
  runWorkflow,
  saveWorkflow,
} from '../dist/workflow/store.js';

const SCRIPT = `const t = await tools.upper({ text: 'hi' });
const r = await task({ description: 'review', subagentType: 'reviewer' });
t + '|' + r;`;

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'omm-workflow-'));
  try {
    return await fn(new StateStore({ workspaceRoot: dir }), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fixtures() {
  const dispatched = [];
  return {
    dispatched,
    tools: { upper: async (args) => String(args.text).toUpperCase() },
    dispatcher: async (dispatch) => {
      dispatched.push({ ...dispatch });
      return 'OK';
    },
  };
}

const DEFINITION = {
  name: 'triage-demo',
  script: SCRIPT,
  ptc: ['upper'],
  subagentMap: { reviewer: { model: 'saved-model', effort: 'saved-effort' } },
};

test('save, list, re-run byte-identically, then delete', async () => {
  await withStore(async (store, dir) => {
    saveWorkflow(store, DEFINITION);
    assert.deepEqual(listWorkflows(store), ['triage-demo']);
    assert.ok(existsSync(join(dir, '.omm', 'workflows', 'triage-demo.json')));
    const saved = JSON.parse(
      readFileSync(join(dir, '.omm', 'workflows', 'triage-demo.json'), 'utf8'),
    );
    assert.equal(saved.name, 'triage-demo');

    const first = await runWorkflow(store, 'triage-demo', fixtures());
    const second = await runWorkflow(store, 'triage-demo', fixtures());
    assert.equal(first.ok, true);
    assert.equal(first.text, 'HI|OK');
    assert.equal(second.text, first.text);
    assert.ok(Buffer.from(second.text).equals(Buffer.from(first.text)));

    assert.equal(deleteWorkflow(store, 'triage-demo'), true);
    assert.deepEqual(listWorkflows(store), []);
    await assert.rejects(runWorkflow(store, 'triage-demo', fixtures()), /Unknown workflow/);
  });
});

test('a re-run dispatches the saved model and effort defaults', async () => {
  await withStore(async (store) => {
    saveWorkflow(store, DEFINITION);
    const seen = fixtures();
    const response = await runWorkflow(store, 'triage-demo', seen);
    assert.equal(response.ok, true);
    assert.equal(seen.dispatched.length, 1);
    assert.equal(seen.dispatched[0].model, 'saved-model');
    assert.equal(seen.dispatched[0].effort, 'saved-effort');
  });
});
