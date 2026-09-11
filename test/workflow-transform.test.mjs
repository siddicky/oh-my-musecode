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
