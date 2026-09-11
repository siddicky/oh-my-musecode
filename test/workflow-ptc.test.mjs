import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowInterpreter } from '../dist/workflow/interpreter.js';

function withInterpreter(options, fn) {
  const interpreter = new WorkflowInterpreter(options);
  return (async () => {
    try {
      await fn(interpreter);
    } finally {
      interpreter.disposeAll();
    }
  })();
}

test('an allowlisted tool is callable as camelCase tools.*', async () => {
  await withInterpreter(
    { config: { ptc: { web_search: async (args) => `hits:${args.query}` } } },
    async (interpreter) => {
      const response = await interpreter.evaluate(
        'us003-call',
        `await tools.webSearch({ query: 'deepagents' });`,
      );
      assert.equal(response.ok, true);
      assert.equal(response.result, 'hits:deepagents');
    },
  );
});

test('a non-allowlisted tool name is absent, not stubbed', async () => {
  await withInterpreter({ config: { ptc: {} } }, async (interpreter) => {
    const response = await interpreter.evaluate('us003-absent', `typeof tools.secretTool;`);
    assert.equal(response.ok, true);
    assert.equal(response.result, 'undefined');
  });
});

test('exceeding maxPtcCalls fails without further invocations', async () => {
  let invocations = 0;
  await withInterpreter(
    {
      config: {
        maxPtcCalls: 2,
        ptc: {
          ping: async () => {
            invocations += 1;
            return invocations;
          },
        },
      },
    },
    async (interpreter) => {
      const response = await interpreter.evaluate(
        'us003-cap',
        'await tools.ping({}); await tools.ping({}); await tools.ping({});',
      );
      assert.equal(response.ok, false);
      assert.match(response.error ?? '', /maxPtcCalls/);
      assert.equal(invocations, 2);
    },
  );
});

test('an unbridgable tool value fails fast instead of hanging to timeout', async () => {
  await withInterpreter(
    {
      config: {
        executionTimeoutMs: 2000,
        ptc: {
          // JSON.stringify(BigInt) throws, so fromNative cannot bridge this.
          bigint: async () => 10n,
        },
      },
    },
    async (interpreter) => {
      const start = Date.now();
      const response = await interpreter.evaluate('us003-unbridgable', 'await tools.bigint({});');
      const elapsed = Date.now() - start;
      assert.equal(response.ok, false);
      assert.match(response.error ?? '', /Cannot bridge host value/);
      assert.ok(elapsed < 2000, `must fail fast, not hang to timeout (took ${elapsed}ms)`);
    },
  );
});

test('unleashed mode ignores maxPtcCalls', async () => {
  let invocations = 0;
  await withInterpreter(
    {
      config: {
        ptcMode: 'unleashed',
        maxPtcCalls: 1,
        ptc: {
          ping: async () => {
            invocations += 1;
            return invocations;
          },
        },
      },
    },
    async (interpreter) => {
      const response = await interpreter.evaluate(
        'us003-unleashed-cap',
        'await tools.ping({}); await tools.ping({}); await tools.ping({});',
      );
      assert.equal(response.ok, true);
      assert.equal(invocations, 3);
    },
  );
});

test('unleashed mode resolves unlisted tools through the resolver', async () => {
  await withInterpreter(
    {
      config: { ptcMode: 'unleashed', ptc: { listed_tool: async () => 'listed' } },
      toolResolver: (name) => (name === 'anything' ? async (args) => `r:${args.x}` : undefined),
    },
    async (interpreter) => {
      const response = await interpreter.evaluate(
        'us003-unleashed-resolve',
        `[await tools.anything({ x: 1 }), await tools.listedTool({})].join(',');`,
      );
      assert.equal(response.ok, true);
      assert.equal(response.result, 'r:1,listed');
    },
  );
});

test('unleashed mode leaves unresolvable tools absent and hides the bridge', async () => {
  await withInterpreter(
    {
      config: { ptcMode: 'unleashed', ptc: {} },
      toolResolver: () => undefined,
    },
    async (interpreter) => {
      const response = await interpreter.evaluate(
        'us003-unleashed-absent',
        `[typeof tools.nope, 'nope' in tools, typeof __ptcHas, typeof __ptcCall].join(',');`,
      );
      assert.equal(response.ok, true);
      assert.equal(response.result, 'undefined,false,undefined,undefined');
    },
  );
});

test('guarded mode ignores the resolver', async () => {
  await withInterpreter(
    {
      config: { ptc: {} },
      toolResolver: () => async () => 'resolved',
    },
    async (interpreter) => {
      const response = await interpreter.evaluate('us003-guarded-resolver', 'typeof tools.anything;');
      assert.equal(response.ok, true);
      assert.equal(response.result, 'undefined');
    },
  );
});

test('unleashed allowlist wins over the resolver for the same name', async () => {
  await withInterpreter(
    {
      config: { ptcMode: 'unleashed', ptc: { dup: async () => 'listed' } },
      toolResolver: () => async () => 'resolved',
    },
    async (interpreter) => {
      const response = await interpreter.evaluate('us003-unleashed-precedence', 'await tools.dup({});');
      assert.equal(response.ok, true);
      assert.equal(response.result, 'listed');
    },
  );
});

test('Promise.all over tools.* returns results in dispatch order', async () => {
  await withInterpreter(
    {
      config: {
        ptc: {
          echo: async (args) => {
            const delay = Number(args.ms ?? 0);
            await new Promise((resolve) => setTimeout(resolve, delay));
            return args.n;
          },
        },
      },
    },
    async (interpreter) => {
      const response = await interpreter.evaluate(
        'us003-parallel',
        `await Promise.all([
           tools.echo({ n: 1, ms: 30 }),
           tools.echo({ n: 2, ms: 0 }),
           tools.echo({ n: 3, ms: 10 }),
         ]);`,
      );
      assert.equal(response.ok, true);
      assert.deepEqual(response.result, [1, 2, 3]);
    },
  );
});
