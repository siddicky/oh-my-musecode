import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WorkflowInterpreter } from '../dist/workflow/interpreter.js';
import { createWorkflowTool } from '../dist/workflow/tool.js';
import { DEFAULT_WORKFLOW_CONFIG } from '../dist/workflow/types.js';

const EXPECTED_CONFIG_KEYS = [
  'captureConsole',
  'executionTimeoutMs',
  'maxPtcCalls',
  'maxResultChars',
  'maxStackSizeBytes',
  'memoryLimitBytes',
  'ptc',
  'ptcMode',
  'subagents',
  'systemPrompt',
  'toolName',
];

test('the config type exposes the full langchain-parity surface', () => {
  const keys = Object.keys(new WorkflowInterpreter().config).sort();
  assert.deepEqual(keys, EXPECTED_CONFIG_KEYS);
});

test('per-call options override site defaults', async () => {
  const interpreter = new WorkflowInterpreter({ config: { executionTimeoutMs: 8000 } });
  try {
    const start = Date.now();
    const response = await interpreter.evaluate('us006-precedence', 'while (true) {}', {
      executionTimeoutMs: 300,
    });
    const elapsed = Date.now() - start;
    assert.equal(response.ok, false);
    assert.match(response.error ?? '', /timed out|interrupt/i);
    assert.ok(elapsed < 8000, `call-level timeout must win (took ${elapsed}ms)`);
  } finally {
    interpreter.disposeAll();
  }
});

test('defaults match the ralplan-confirmed values', () => {
  assert.deepEqual(DEFAULT_WORKFLOW_CONFIG, {
    memoryLimitBytes: 32 * 1024 * 1024,
    maxStackSizeBytes: 256 * 1024,
    executionTimeoutMs: 8000,
    toolName: 'eval',
    captureConsole: true,
    maxResultChars: 8000,
    systemPrompt: null,
    ptc: {},
    maxPtcCalls: 64,
    ptcMode: 'guarded',
    subagents: true,
  });
});

test('constructing the tool dispatches nothing, even at ultra effort', async () => {
  let dispatches = 0;
  const tool = createWorkflowTool({
    config: { ptc: {} },
    subagentMap: { worker: { model: 'm', effort: 'ultra' } },
    dispatcher: async () => {
      dispatches += 1;
      return 'x';
    },
  });
  assert.equal(tool.name, 'eval');
  assert.equal(dispatches, 0);
  tool.interpreter.disposeAll();
});

test('no auto-fire wiring exists in src/', () => {
  const hits = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && path.endsWith('.ts')) {
        const body = readFileSync(path, 'utf8');
        if (/autoTrigger|autoFire|onUltra/.test(body)) hits.push(path);
      }
    }
  };
  visit('src');
  assert.deepEqual(hits, []);
});

test('ultra effort on a task() call is forwarded as a routing choice only', async () => {
  const seen = [];
  const tool = createWorkflowTool({
    subagentMap: { worker: { model: 'm', effort: 'standard' } },
    dispatcher: async (dispatch) => {
      seen.push(dispatch);
      return 'done';
    },
  });
  try {
    const response = await tool.run(
      'us007-ultra',
      `await task({ description: 'deep', subagentType: 'worker', effort: 'ultra' });`,
    );
    assert.equal(response.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].effort, 'ultra');
  } finally {
    tool.interpreter.disposeAll();
  }
});
