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

test('guarded mode: calling an unlisted tool throws TypeError in the VM and never reaches the host', async () => {
  let hostCalls = 0;
  let resolverCalls = 0;
  await withInterpreter(
    {
      config: {
        ptc: {
          listed: async () => {
            hostCalls += 1;
            return 'listed';
          },
        },
      },
      toolResolver: () => {
        resolverCalls += 1;
        return async () => 'resolved';
      },
    },
    async (interpreter) => {
      const response = await interpreter.evaluate(
        'us003-guarded-unlisted-call',
        `let caught = 'no throw';
         try { await tools.secretTool({}); }
         catch (e) { caught = JSON.stringify({ isTypeError: e instanceof TypeError, message: e.message }); }
         caught;`,
      );
      assert.equal(response.ok, true);
      const caught = JSON.parse(response.result);
      assert.equal(caught.isTypeError, true);
      assert.match(caught.message, /not a function/);
      assert.equal(hostCalls, 0);
      assert.equal(resolverCalls, 0);
    },
  );
});

test('unleashed mode: calling an unresolvable tool throws TypeError without invoking any tool', async () => {
  let hostCalls = 0;
  await withInterpreter(
    {
      config: {
        ptcMode: 'unleashed',
        ptc: {
          listed: async () => {
            hostCalls += 1;
            return 'listed';
          },
        },
      },
      toolResolver: () => undefined,
    },
    async (interpreter) => {
      const response = await interpreter.evaluate(
        'us003-unleashed-unresolvable-call',
        `let caught = 'no throw';
         try { await tools.nope({}); }
         catch (e) { caught = JSON.stringify({ isTypeError: e instanceof TypeError, message: e.message }); }
         caught;`,
      );
      assert.equal(response.ok, true);
      const caught = JSON.parse(response.result);
      assert.equal(caught.isTypeError, true);
      assert.match(caught.message, /not a function/);
      assert.equal(hostCalls, 0);
    },
  );
});

test('unleashed mode: a tool the resolver drops after lookup fails on the host as Unknown tool', async () => {
  let available = true;
  let flakyCalls = 0;
  await withInterpreter(
    {
      config: {
        ptcMode: 'unleashed',
        ptc: {
          drop: async () => {
            available = false;
            return 'dropped';
          },
        },
      },
      toolResolver: (name) =>
        name === 'flaky' && available
          ? async () => {
              flakyCalls += 1;
              return 'ran';
            }
          : undefined,
    },
    async (interpreter) => {
      // Capture tools.flaky while it resolves, then drop it host-side before calling.
      const response = await interpreter.evaluate(
        'us003-unleashed-dropped',
        `const flaky = tools.flaky;
         await tools.drop({});
         let caught = 'no throw';
         try { await flaky({}); }
         catch (e) { caught = JSON.stringify({ isError: e instanceof Error, message: e.message }); }
         caught;`,
      );
      assert.equal(response.ok, true, response.error);
      const caught = JSON.parse(response.result);
      assert.equal(caught.isError, true);
      assert.equal(caught.message, 'Unknown tool "flaky": the resolver has no such tool.');
      assert.equal(flakyCalls, 0);
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

test('a throwing tool rejects with a catchable Error, not a bare string', async () => {
  await withInterpreter(
    {
      config: {
        ptc: {
          boom: async () => {
            const error = new Error('upstream 503');
            error.name = 'UpstreamError';
            throw error;
          },
        },
      },
    },
    async (interpreter) => {
      const response = await interpreter.evaluate(
        'us003-reject-shape',
        `let caught = 'no throw';
         try { await tools.boom({}); }
         catch (e) { caught = JSON.stringify({ isError: e instanceof Error, name: e.name, message: e.message }); }
         caught;`,
      );
      assert.equal(response.ok, true);
      assert.deepEqual(JSON.parse(response.result), {
        isError: true,
        name: 'UpstreamError',
        message: 'upstream 503',
      });
    },
  );
});
