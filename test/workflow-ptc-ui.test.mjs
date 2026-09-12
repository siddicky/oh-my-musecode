import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowHost } from '../dist/workflow/host.js';
import { WorkflowInterpreter } from '../dist/workflow/interpreter.js';

/**
 * A /workflows-style tool-call projection over WorkflowHost events: PTC
 * calls surface as kind:'ptc' rows keyed by tool name, next to the
 * kind:'subagent' run rows that task() dispatches produce.
 */
function projectToolCalls(events) {
  const calls = new Map();
  for (const event of events) {
    if (event.kind !== 'ptc') continue;
    let call = calls.get(event.toolCallId);
    if (!call) {
      call = {
        toolCallId: event.toolCallId,
        tool: event.tool,
        types: [],
        status: 'running',
        outputLength: undefined,
      };
      calls.set(event.toolCallId, call);
    }
    call.types.push(event.type);
    if (event.type === 'completed') {
      call.status = 'completed';
      call.outputLength = event.outputLength;
    }
  }
  return [...calls.values()];
}

test('PTC calls project to tool rows keyed by tool name next to subagent runs', async () => {
  const host = new WorkflowHost();
  const interpreter = new WorkflowInterpreter({
    config: {
      ptc: {
        web_search: async (args) => ({ hits: [args.q] }),
        summarizer: async () => 'short',
      },
    },
    subagentMap: { worker: { model: 'm', effort: 'e' } },
    dispatcher: async () => 'agent-out',
    host,
  });
  try {
    const response = await interpreter.evaluate(
      'ptc-ui-mixed',
      `const [a, b] = await Promise.all([
         tools.webSearch({ q: 'x' }),
         tools.summarizer({}),
       ]);
       const c = await task({ description: 'work', subagentType: 'worker' });
       JSON.stringify([a, b, c]);`,
    );
    assert.equal(response.ok, true);

    const tools = projectToolCalls(host.events);
    assert.equal(tools.length, 2);
    const byTool = new Map(tools.map((row) => [row.tool, row]));
    assert.deepEqual(byTool.get('web_search').types, ['started', 'completed']);
    assert.deepEqual(byTool.get('summarizer').types, ['started', 'completed']);
    assert.equal(byTool.get('web_search').status, 'completed');
    assert.equal(
      byTool.get('web_search').outputLength,
      JSON.stringify({ hits: ['x'] }).length,
    );
    assert.equal(
      byTool.get('summarizer').outputLength,
      JSON.stringify('short').length,
    );
    // Tool-call ids live apart from run ids and are not cancellable runs.
    const ids = tools.map((row) => row.toolCallId);
    assert.deepEqual(ids, ['ptc-1', 'ptc-2']);
    for (const id of ids) {
      assert.equal(host.cancel(id), false);
      assert.equal(host.restart(id), false);
    }

    // Subagent rows are unchanged apart from the kind discriminator.
    const runs = host.events.filter((e) => e.kind === 'subagent');
    assert.deepEqual(
      runs.map((e) => e.type),
      ['started', 'progress', 'completed'],
    );
    assert.equal(runs[0].runId, 'run-1');
    assert.equal(runs[0].description, 'work');
  } finally {
    interpreter.disposeAll();
  }
});

test('a throwing tool emits started with no terminal row and rejects the eval', async () => {
  const host = new WorkflowHost();
  const interpreter = new WorkflowInterpreter({
    config: {
      ptc: {
        boom: async () => {
          throw new Error('tool exploded');
        },
      },
    },
    host,
  });
  try {
    const response = await interpreter.evaluate('ptc-ui-fail', `await tools.boom({});`);
    assert.equal(response.ok, false);
    assert.match(response.error ?? '', /tool exploded/);
    const rows = host.events.filter((e) => e.kind === 'ptc');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'started');
    assert.equal(rows[0].tool, 'boom');
  } finally {
    interpreter.disposeAll();
  }
});

test('cap-exceeded calls emit no rows; only admitted calls appear', async () => {
  const host = new WorkflowHost();
  const interpreter = new WorkflowInterpreter({
    config: { ptc: { a: async () => 'A' }, maxPtcCalls: 1 },
    host,
  });
  try {
    const response = await interpreter.evaluate(
      'ptc-ui-cap',
      `await tools.a({}); await tools.a({});`,
    );
    assert.equal(response.ok, false);
    assert.match(response.error ?? '', /maxPtcCalls/);
    const rows = host.events.filter((e) => e.kind === 'ptc');
    assert.deepEqual(
      rows.map((row) => row.type),
      ['started', 'completed'],
    );
    assert.equal(rows[0].toolCallId, 'ptc-1');
  } finally {
    interpreter.disposeAll();
  }
});

test('unleashed tools report the accessed property name', async () => {
  const host = new WorkflowHost();
  const interpreter = new WorkflowInterpreter({
    config: { ptc: {}, ptcMode: 'unleashed' },
    toolResolver: (name) => (name === 'customTool' ? async () => 42 : undefined),
    host,
  });
  try {
    const response = await interpreter.evaluate(
      'ptc-ui-unleashed',
      `await tools.customTool({}); 'ok';`,
    );
    assert.equal(response.ok, true);
    const rows = host.events.filter((e) => e.kind === 'ptc');
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.type),
      ['started', 'completed'],
    );
    assert.equal(rows[0].tool, 'customTool');
    assert.equal(rows[1].tool, 'customTool');
    assert.equal(rows[1].outputLength, JSON.stringify(42).length);
  } finally {
    interpreter.disposeAll();
  }
});

test('un-allowlisted calls emit no rows in either PTC mode', async () => {
  const guardedHost = new WorkflowHost();
  const guarded = new WorkflowInterpreter({
    config: { ptc: { a: async () => 'A' } },
    host: guardedHost,
  });
  try {
    const response = await guarded.evaluate('ptc-ui-denied', `await tools.nope({});`);
    assert.equal(response.ok, false);
    assert.equal(
      guardedHost.events.filter((e) => e.kind === 'ptc').length,
      0,
    );
    assert.equal(guardedHost.events.length, 0);
  } finally {
    guarded.disposeAll();
  }

  const unleashedHost = new WorkflowHost();
  const unleashed = new WorkflowInterpreter({
    config: { ptc: {}, ptcMode: 'unleashed' },
    toolResolver: () => undefined,
    host: unleashedHost,
  });
  try {
    const response = await unleashed.evaluate(
      'ptc-ui-unresolved',
      `await tools.nope({});`,
    );
    assert.equal(response.ok, false);
    assert.equal(unleashedHost.events.length, 0);
  } finally {
    unleashed.disposeAll();
  }
});

test('a throwing listener does not break the PTC lifecycle', async () => {
  const host = new WorkflowHost(() => {
    throw new Error('listener boom');
  });
  const interpreter = new WorkflowInterpreter({
    config: { ptc: { a: async () => 'A' } },
    host,
  });
  try {
    const response = await interpreter.evaluate(
      'ptc-ui-listener',
      `await tools.a({}); 'done';`,
    );
    assert.equal(response.ok, true);
    assert.equal(response.text, 'done');
    assert.deepEqual(
      host.events.map((e) => e.type),
      ['started', 'completed'],
    );
  } finally {
    interpreter.disposeAll();
  }
});
