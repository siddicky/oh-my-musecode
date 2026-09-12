import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  NATIVE_HOST_API_VERSION,
  NATIVE_PARALLEL_CHILD_LIMIT,
  buildNativePtcScript,
  buildNativeFanoutScript,
} from '../dist/workflow/native.js';

/** `node --check` the script as an ES module — generated output must parse. */
function assertParses(name, script) {
  const dir = mkdtempSync(join(tmpdir(), 'native-wf-'));
  const file = join(dir, `${name}.mjs`);
  try {
    writeFileSync(file, script, 'utf8');
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('native generators target host API v1 and the observed child limit', () => {
  assert.equal(NATIVE_HOST_API_VERSION, 'v1');
  assert.equal(NATIVE_PARALLEL_CHILD_LIMIT, 8);
});

test('fan-out script: shape, labels, synthesis, and module syntax', () => {
  const { script, notes } = buildNativeFanoutScript([
    { description: 'Review src/auth.ts', personaText: 'You are a critic persona.', label: 'auth-review' },
    { description: 'Review src/routes/api.ts', label: 'api-review' },
  ]);
  assert.deepEqual(notes, []);
  assert.ok(script.includes('export default async function workflow(host)'));
  assert.ok(script.includes('await host.parallel(['));
  assert.ok(script.includes('label: "auth-review"'));
  assert.ok(script.includes('label: "api-review"'));
  assert.ok(script.includes('You are a critic persona.'));
  assert.ok(script.includes('await host.agent({ input:'));
  assert.ok(script.includes('synthesis: { ref: synthesis.ref, text: synthesis.text }'));
  assertParses('fanout', script);
});

test('fan-out script: more than 8 tasks auto-batch sequentially', () => {
  const tasks = Array.from({ length: 11 }, (_, i) => ({ description: `task ${i + 1}` }));
  const { script, notes } = buildNativeFanoutScript(tasks);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /11 children split into 2 sequential batches/);
  assert.ok(script.includes('const batch1 = await host.parallel('));
  assert.ok(script.includes('const batch2 = await host.parallel('));
  assert.ok(script.includes('[].concat(batch1, batch2)'));
  assertParses('fanout-batched', script);
});

test('fan-out script: empty or blank tasks are rejected', () => {
  assert.throws(() => buildNativeFanoutScript([]), /no tasks given/);
  assert.throws(() => buildNativeFanoutScript([{ description: '   ' }]), /empty input/);
});

test('PTC script: single allowlisted call becomes one agent child', () => {
  const { script, notes } = buildNativePtcScript(
    [{ tool: 'web_search', args: { query: 'muse code workflows' } }],
    { allowlist: ['web_search'], maxCalls: 5 },
  );
  assert.deepEqual(notes, []);
  assert.ok(script.includes('await host.agent('));
  assert.ok(script.includes('host tool named \\"web_search\\"'));
  assert.ok(script.includes('{\\"query\\":\\"muse code workflows\\"}'));
  assert.ok(!script.includes('host.parallel'));
  assertParses('ptc-single', script);
});

test('PTC script: guarded mode refuses un-allowlisted and cap-exceeded calls, never silently', () => {
  const { script, notes } = buildNativePtcScript(
    [
      { tool: 'web_search', args: {} },
      { tool: 'shell', args: { cmd: 'rm -rf /' } },
      { tool: 'web_search', args: {} },
    ],
    { allowlist: ['web_search'], maxCalls: 1 },
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0], /2 call\(s\) refused/);
  assert.match(notes[0], /shell \(not allowlisted\)/);
  assert.match(notes[0], /web_search \(maxPtcCalls exceeded\)/);
  // The refused shell call must not appear as an emitted child instruction.
  assert.ok(!script.includes('rm -rf /'));
  assert.ok(script.includes('refusals: [{'));
  assert.match(script, /\{"label":"shell","error":"not allowlisted"\}/);
  assert.match(script, /\{"label":"web_search","error":"maxPtcCalls exceeded"\}/);
  assertParses('ptc-guarded', script);
});

test('PTC script: deliberate-open batch passes the intended tools as the allowlist', () => {
  const calls = Array.from({ length: 5 }, () => ({ tool: 'anything', args: { ok: true } }));
  const { script, notes } = buildNativePtcScript(calls, {
    allowlist: [...new Set(calls.map((c) => c.tool))],
  });
  assert.deepEqual(notes, []);
  assert.ok(script.includes('await host.parallel('));
  assert.ok(script.includes('label: "anything-5"'));
  assertParses('ptc-open-explicit', script);
});

test('PTC script: batch beyond the native child limit auto-batches', () => {
  const calls = Array.from({ length: 11 }, (_, i) => ({ tool: `tool_${i}`, args: {} }));
  const { script, notes } = buildNativePtcScript(calls, {
    allowlist: calls.map((c) => c.tool),
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /11 children split into 2 sequential batches/);
  assert.ok(script.includes('const batch1 = await host.parallel('));
  assert.ok(script.includes('const batch2 = await host.parallel('));
  assert.ok(script.includes('[].concat(batch1, batch2)'));
  assert.ok(script.includes('host tool named \\"tool_10\\"'));
  assert.ok(script.includes('label: "tool_10-11"'));
  assertParses('ptc-batched', script);
});

test('PTC script: fail-closed by default — no allowlist admits nothing', () => {
  assert.throws(
    () => buildNativePtcScript([{ tool: 'read_file', args: {} }]),
    /no admitted calls/,
  );
});

test('PTC script: all-refused batch throws instead of emitting an empty script', () => {
  assert.throws(
    () => buildNativePtcScript([{ tool: 'shell', args: {} }], { allowlist: [] }),
    /no admitted calls/,
  );
});
