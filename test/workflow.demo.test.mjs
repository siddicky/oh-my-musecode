import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { createWorkflowTool } from '../dist/workflow/tool.js';

// End-to-end demo: parallel PTC calls plus parallel task() dispatches joined
// in-interpreter. This file runs under `node --test` as part of `npm test`.
test('demo: parallel tools and parallel subagents join to one exact result', async () => {
  const tool = createWorkflowTool({
    config: {
      ptc: {
        alpha: async () => 'alpha-out',
        beta: async () => 'beta-out',
      },
    },
    subagentMap: {
      t1: { model: 'demo-model', effort: 'standard' },
      t2: { model: 'demo-model', effort: 'ultra' },
    },
    dispatcher: async (dispatch) => `${dispatch.subagentType}:${dispatch.effort}`,
  });
  try {
    const response = await tool.run(
      'demo-fanout',
      `const [a, b] = await Promise.all([tools.alpha({}), tools.beta({})]);
       const [x, y] = await Promise.all([
         task({ description: 'first', subagentType: 't1' }),
         task({ description: 'second', subagentType: 't2' }),
       ]);
       [a, b, x, y].join('|');`,
    );
    assert.equal(response.ok, true);
    assert.equal(response.text, 'alpha-out|beta-out|t1:standard|t2:ultra');
  } finally {
    tool.interpreter.disposeAll();
  }
});

test('demo: compiled workflow output exists under dist/', () => {
  assert.ok(existsSync('dist/workflow/interpreter.js'), 'dist/workflow/interpreter.js missing');
  assert.ok(existsSync('dist/workflow/tool.js'), 'dist/workflow/tool.js missing');
  assert.ok(existsSync('dist/workflow/store.js'), 'dist/workflow/store.js missing');
});

test('demo: skill docs guide usage with examples', () => {
  const docs = readFileSync('skills/workflow/SKILL.md', 'utf8');
  assert.ok(docs.includes('When to use'), 'docs must say when to use the interpreter');
  assert.ok(docs.includes('tools.webSearch'), 'docs must include a PTC example');
  assert.ok(docs.includes('subagentType'), 'docs must include a task() fan-out example');
  assert.ok(docs.includes('effort'), 'docs must document model/effort configuration');
});
