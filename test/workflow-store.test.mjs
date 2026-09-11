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

test('saved workflows persist the PTC mode and default to guarded', async () => {
  await withStore(async (store, dir) => {
    saveWorkflow(store, { ...DEFINITION, name: 'open', ptcMode: 'unleashed' });
    saveWorkflow(store, { ...DEFINITION, name: 'shut' });
    const open = JSON.parse(
      readFileSync(join(dir, '.omm', 'workflows', 'open.json'), 'utf8'),
    );
    const shut = JSON.parse(
      readFileSync(join(dir, '.omm', 'workflows', 'shut.json'), 'utf8'),
    );
    assert.equal(open.ptcMode, 'unleashed');
    assert.equal(shut.ptcMode, 'guarded');
  });
});

test('a re-run replays unleashed mode with a re-supplied resolver', async () => {
  await withStore(async (store) => {
    saveWorkflow(store, {
      name: 'open-run',
      script: `await tools.unlisted({}); await tools.unlisted({}); 'done';`,
      ptc: [],
      ptcMode: 'unleashed',
      limits: { maxPtcCalls: 1 },
    });
    // Guarded replay would fail twice over: unlisted tool, over the call cap.
    const response = await runWorkflow(store, 'open-run', {
      tools: {},
      toolResolver: () => async () => 'r',
    });
    assert.equal(response.ok, true);
    assert.equal(response.text, 'done');
  });
});

test('a workflow saved before the mode existed replays guarded', async () => {
  await withStore(async (store) => {
    const legacy = {
      name: 'legacy',
      script: `await tools.upper({ text: 'a' }); await tools.upper({ text: 'b' });`,
      ptc: ['upper'],
      subagentMap: {},
      limits: {
        memoryLimitBytes: 32 * 1024 * 1024,
        maxStackSizeBytes: 256 * 1024,
        executionTimeoutMs: 8000,
        maxResultChars: 8000,
        maxPtcCalls: 1,
      },
      createdAt: new Date(0).toISOString(),
    };
    store.write('workflows/legacy.json', JSON.stringify(legacy));
    const response = await runWorkflow(store, 'legacy', {
      tools: { upper: async (args) => String(args.text).toUpperCase() },
    });
    assert.equal(response.ok, false);
    assert.match(response.error ?? '', /maxPtcCalls/);
  });
});
