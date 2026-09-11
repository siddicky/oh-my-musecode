import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowHost } from '../dist/workflow/host.js';
import { WorkflowInterpreter } from '../dist/workflow/interpreter.js';

function canned(outputs) {
  const calls = [];
  const dispatcher = async (dispatch) => {
    calls.push({ ...dispatch });
    return outputs[dispatch.subagentType] ?? `${dispatch.subagentType}-out`;
  };
  return { calls, dispatcher };
}

test('parallel task() dispatches join to an exact blank-line text', async () => {
  const { dispatcher } = canned({ a: 'A-out', b: 'B-out' });
  const interpreter = new WorkflowInterpreter({
    subagentMap: { a: { model: 'm', effort: 'e' }, b: { model: 'm', effort: 'e' } },
    dispatcher,
  });
  try {
    const response = await interpreter.evaluate(
      'us004-join',
      `const rs = await Promise.all([
         task({ description: 'first', subagentType: 'a' }),
         task({ description: 'second', subagentType: 'b' }),
       ]);
       rs.join('\\n\\n');`,
    );
    assert.equal(response.ok, true);
    assert.equal(response.text, 'A-out\n\nB-out');
  } finally {
    interpreter.disposeAll();
  }
});

test('task() forwards description, type, model, and effort exactly', async () => {
  const { calls, dispatcher } = canned({});
  const interpreter = new WorkflowInterpreter({
    subagentMap: { reviewer: { model: 'map-model', effort: 'map-effort' } },
    dispatcher,
  });
  try {
    const response = await interpreter.evaluate(
      'us004-forward',
      `await task({ description: 'Check auth', subagentType: 'reviewer', model: 'call-model', effort: 'ultra' });`,
    );
    assert.equal(response.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].description, 'Check auth');
    assert.equal(calls[0].subagentType, 'reviewer');
    assert.equal(calls[0].model, 'call-model');
    assert.equal(calls[0].effort, 'ultra');
  } finally {
    interpreter.disposeAll();
  }
});

test('omitted model and effort fall back to caller-map defaults', async () => {
  const { calls, dispatcher } = canned({});
  const interpreter = new WorkflowInterpreter({
    subagentMap: { reviewer: { model: 'map-model', effort: 'map-effort' } },
    dispatcher,
  });
  try {
    const response = await interpreter.evaluate(
      'us004-defaults',
      `await task({ description: 'Check auth', subagentType: 'reviewer' });`,
    );
    assert.equal(response.ok, true);
    assert.equal(calls[0].model, 'map-model');
    assert.equal(calls[0].effort, 'map-effort');
  } finally {
    interpreter.disposeAll();
  }
});

test('an unmapped subagent type fails with an unknown-subagent error', async () => {
  const { dispatcher } = canned({});
  const interpreter = new WorkflowInterpreter({ subagentMap: {}, dispatcher });
  try {
    const response = await interpreter.evaluate(
      'us004-unknown',
      `await task({ description: 'x', subagentType: 'nope' });`,
    );
    assert.equal(response.ok, false);
    assert.match(response.error ?? '', /Unknown subagent type.*nope/);
  } finally {
    interpreter.disposeAll();
  }
});

test('subagents:false removes the task global', async () => {
  const interpreter = new WorkflowInterpreter({ config: { subagents: false } });
  try {
    const response = await interpreter.evaluate('us004-off', 'typeof task;');
    assert.equal(response.ok, true);
    assert.equal(response.result, 'undefined');
  } finally {
    interpreter.disposeAll();
  }
});

async function waitFor(events, predicate, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const found = events.find(predicate);
    if (found) return found;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for host event');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('dispatches emit lifecycle events; cancel terminates, restart re-runs', async () => {
  const host = new WorkflowHost();
  const gate = { release: null };
  const blocker = () => new Promise((resolve) => { gate.release = resolve; });
  const seen = [];
  const dispatcher = async (dispatch) => {
    seen.push({ ...dispatch });
    if (dispatch.attempt === 1) {
      await blocker();
      return 'first';
    }
    return 'second';
  };
  const interpreter = new WorkflowInterpreter({
    subagentMap: { worker: { model: 'm', effort: 'e' } },
    dispatcher,
    host,
  });
  try {
    const pending = interpreter.evaluate(
      'us004-lifecycle',
      `await task({ description: 'work', subagentType: 'worker' });`,
    );
    const started = await waitFor(host.events, (e) => e.type === 'started');
    assert.equal(started.attempt, 1);
    assert.ok(host.restart(started.runId), 'restart should hit the running dispatch');
    const restarted = await waitFor(host.events, (e) => e.type === 'started' && e.attempt === 2);
    assert.equal(restarted.runId, started.runId);
    gate.release();
    const response = await pending;
    assert.equal(response.ok, true);
    assert.equal(response.result, 'second');
    const completed = host.events.filter((e) => e.type === 'completed');
    assert.equal(completed.length, 1);
    assert.ok(host.events.some((e) => e.type === 'progress'), 'expected a progress event');
  } finally {
    interpreter.disposeAll();
  }
});

test('cancel aborts the signal handed to the dispatcher', async () => {
  const host = new WorkflowHost();
  let seen;
  const dispatcher = (dispatch) => {
    seen = dispatch.signal;
    return new Promise(() => {});
  };
  const pending = host.run(
    { description: 'work', subagentType: 'worker', model: 'm', effort: 'e' },
    dispatcher,
  );
  const started = await waitFor(host.events, (e) => e.type === 'started');
  assert.ok(seen instanceof AbortSignal, 'dispatcher must receive an AbortSignal');
  assert.equal(seen.aborted, false);
  assert.ok(host.cancel(started.runId), 'cancel should hit the running dispatch');
  await assert.rejects(pending, /cancelled/);
  assert.equal(seen.aborted, true);
  assert.equal(seen.reason, 'cancelled');
});

test('restart aborts the attempt signal and hands the next attempt a fresh one', async () => {
  const host = new WorkflowHost();
  const gate = { release: null };
  const blocker = () => new Promise((resolve) => { gate.release = resolve; });
  const signals = [];
  const dispatcher = async (dispatch) => {
    signals.push(dispatch.signal);
    if (dispatch.attempt === 1) {
      await blocker();
      return 'first';
    }
    return 'second';
  };
  const pending = host.run(
    { description: 'work', subagentType: 'worker', model: 'm', effort: 'e' },
    dispatcher,
  );
  const started = await waitFor(host.events, (e) => e.type === 'started');
  assert.ok(host.restart(started.runId), 'restart should hit the running dispatch');
  await waitFor(host.events, (e) => e.type === 'started' && e.attempt === 2);
  gate.release();
  assert.equal(await pending, 'second');
  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[0].reason, 'restart');
  assert.equal(signals[1].aborted, false);
});

test('a synchronously throwing dispatcher rejects the run with its error', async () => {
  const host = new WorkflowHost();
  const dispatcher = () => {
    throw new Error('sync boom');
  };
  await assert.rejects(
    host.run({ description: 'work', subagentType: 'worker', model: 'm', effort: 'e' }, dispatcher),
    /sync boom/,
  );
  assert.deepEqual(
    host.events.map((e) => e.type),
    ['started'],
  );
});

test('a throwing event listener does not break the dispatch lifecycle', async () => {
  const host = new WorkflowHost(() => {
    throw new Error('listener boom');
  });
  const output = await host.run(
    { description: 'work', subagentType: 'worker', model: 'm', effort: 'e' },
    async () => 'done',
  );
  assert.equal(output, 'done');
  assert.ok(host.events.some((e) => e.type === 'completed'), 'expected a completed event');
});

test('a host cancel terminates the running dispatch', async () => {
  const host = new WorkflowHost();
  const dispatcher = () => new Promise(() => {});
  const interpreter = new WorkflowInterpreter({
    subagentMap: { worker: { model: 'm', effort: 'e' } },
    dispatcher,
    host,
  });
  try {
    const pending = interpreter.evaluate(
      'us004-cancel',
      `await task({ description: 'work', subagentType: 'worker' });`,
    );
    const started = await waitFor(host.events, (e) => e.type === 'started');
    assert.ok(host.cancel(started.runId), 'cancel should hit the running dispatch');
    const response = await pending;
    assert.equal(response.ok, false);
    assert.match(response.error ?? '', /cancelled/i);
    assert.ok(host.events.some((e) => e.type === 'cancelled'), 'expected a cancelled event');
  } finally {
    interpreter.disposeAll();
  }
});
