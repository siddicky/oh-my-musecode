import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowHost } from '../dist/workflow/host.js';
import { WorkflowInterpreter } from '../dist/workflow/interpreter.js';

/**
 * A /workflows-style run-list projection over WorkflowHost events: the exact
 * stream a native workflow UI adapter consumes. started/progress/completed
 * must project to a consistent run list even when a fan-out mixes a clean
 * completion, a mid-flight cancel, and a restart. The projection narrows on
 * kind:'subagent' first, as every run-list adapter must now that PTC tool
 * rows share the stream.
 */
function projectRunList(events) {
  const runs = new Map();
  for (const event of events) {
    if (event.kind !== 'subagent') continue;
    let run = runs.get(event.runId);
    if (!run) {
      run = {
        runId: event.runId,
        subagentType: event.subagentType,
        description: event.description,
        attempts: [],
        status: 'running',
        outputLength: null,
      };
      runs.set(event.runId, run);
    }
    if (event.type === 'started') run.attempts.push(event.attempt);
    else if (event.type === 'progress') run.outputLength = event.outputLength;
    else if (event.type === 'completed') run.status = 'completed';
    else if (event.type === 'cancelled') run.status = 'cancelled';
  }
  return [...runs.values()];
}

async function waitForCount(events, count, predicate, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const found = events.filter(predicate);
    if (found.length >= count) return found;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for host event');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a mixed fan-out projects to a consistent run list', async () => {
  const host = new WorkflowHost();
  const gates = new Map();
  const arm = (description) => {
    let release = () => {};
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    gates.set(description, { promise, release });
  };
  arm('slow-cancel');
  arm('slow-restart');
  const dispatcher = async (dispatch) => {
    if (dispatch.description === 'fast') return 'fast-out';
    await gates.get(dispatch.description).promise;
    return `${dispatch.description}-out-attempt-${dispatch.attempt}`;
  };
  const interpreter = new WorkflowInterpreter({
    subagentMap: { worker: { model: 'm', effort: 'e' } },
    dispatcher,
    host,
  });
  try {
    const pending = interpreter.evaluate(
      'ui-mixed',
      `const rs = await Promise.all([
         task({ description: 'fast', subagentType: 'worker' }),
         task({ description: 'slow-cancel', subagentType: 'worker' })
           .catch((e) => 'CANCELLED:' + e),
         task({ description: 'slow-restart', subagentType: 'worker' }),
       ]);
       rs.join('\\n');`,
    );
    const started = await waitForCount(
      host.events,
      3,
      (e) => e.type === 'started' && e.attempt === 1,
    );
    const byDescription = new Map(started.map((e) => [e.description, e.runId]));
    assert.ok(host.cancel(byDescription.get('slow-cancel')), 'cancel should hit its run');
    assert.ok(host.restart(byDescription.get('slow-restart')), 'restart should hit its run');
    gates.get('slow-cancel').release();
    gates.get('slow-restart').release();

    const response = await pending;
    assert.equal(response.ok, true);
    assert.match(response.text, /fast-out/);
    assert.match(response.text, /CANCELLED:.*cancelled/i);
    assert.match(response.text, /slow-restart-out-attempt-2/);

    const runs = projectRunList(host.events);
    assert.equal(runs.length, 3);
    const byDesc = new Map(runs.map((run) => [run.description, run]));
    assert.deepEqual(byDesc.get('fast').attempts, [1]);
    assert.equal(byDesc.get('fast').status, 'completed');
    assert.deepEqual(byDesc.get('slow-cancel').attempts, [1]);
    assert.equal(byDesc.get('slow-cancel').status, 'cancelled');
    assert.deepEqual(byDesc.get('slow-restart').attempts, [1, 2]);
    assert.equal(byDesc.get('slow-restart').status, 'completed');
    for (const run of runs) {
      assert.equal(run.subagentType, 'worker');
      assert.deepEqual(run.attempts, [...run.attempts].sort((a, b) => a - b));
    }
    assert.equal(byDesc.get('fast').outputLength, 'fast-out'.length);
    assert.equal(
      byDesc.get('slow-restart').outputLength,
      'slow-restart-out-attempt-2'.length,
    );
    assert.equal(byDesc.get('slow-cancel').outputLength, null);
  } finally {
    interpreter.disposeAll();
  }
});
