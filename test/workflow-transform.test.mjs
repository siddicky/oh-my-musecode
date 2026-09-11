import { test } from 'node:test';
import assert from 'node:assert/strict';

import { transformForEval } from '../dist/workflow/transform.js';

test('a trailing expression is auto-returned inside an async wrapper', () => {
  const transformed = transformForEval('const x = 1;\nx + 1;');
  assert.ok(transformed.startsWith('(async () => {'), 'must wrap in an async IIFE');
  assert.ok(transformed.includes('return (x + 1)'), 'must return the last expression');
  assert.ok(
    transformed.includes('globalThis.x = 1;'),
    'must hoist the declaration for cross-eval persistence',
  );
});

test('unparseable input falls back to a plain async wrapper', () => {
  const transformed = transformForEval('const = ;;;');
  assert.equal(transformed, '(async () => {\nconst = ;;;\n})()');
});

test('function declarations persist via globalThis without changing the body', () => {
  const transformed = transformForEval('function f(n) { return n * 2; }\nf(21);');
  assert.ok(transformed.includes('globalThis.f = f;'), 'must persist the function');
  assert.ok(transformed.includes('return (f(21))'), 'must return the trailing call');
});

test('exported declarations hoist instead of vanishing', () => {
  const exported = transformForEval('export const x = 41;\nx + 1;');
  assert.ok(exported.includes('globalThis.x = 41;'), 'exported const must hoist');
  assert.ok(exported.includes('return (x + 1)'), 'must return the trailing expression');

  const fn = transformForEval('export function f(n) { return n * 2; }\nf(21);');
  assert.ok(fn.includes('function f(n) { return n * 2; }'), 'must keep the function body');
  assert.ok(fn.includes('globalThis.f = f;'), 'exported function must persist');
  assert.ok(fn.includes('return (f(21))'), 'must return the trailing call');
});

test('export specifiers alias renamed bindings and strip re-exports', () => {
  const aliased = transformForEval('const a = 1;\nexport { a as b };');
  assert.ok(aliased.includes('globalThis.b = a'), 'renamed export must alias the binding');
  assert.ok(!aliased.includes('export'), 'no export syntax may survive');

  const reexport = transformForEval('x + 1;\nexport * from "m";');
  assert.ok(reexport.includes('return (x + 1)'), 'a stripped tail must not mask the value');
  assert.ok(!reexport.includes('export'), 'no export syntax may survive');
});

test('syntax newer than the sandbox pin falls back instead of miscompiling', () => {
  // `using` parses under ecmaVersion 'latest' but the sandbox cannot run it;
  // the pinned parse must fail so the plain wrapper reports a clean error.
  const transformed = transformForEval('using x = {}; 1;');
  assert.equal(transformed, '(async () => {\nusing x = {}; 1;\n})()');
});

test('a default export evaluates and returns like a trailing expression', () => {
  const transformed = transformForEval('export default 40 + 2;');
  assert.ok(transformed.includes('return (40 + 2)'), 'must return the default value');
  assert.ok(!transformed.includes('export'), 'no export syntax may survive');
});
