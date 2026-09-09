import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadPersonas, renderPersonaPrompt } from '../dist/personas.js';

const EXPECTED_IDS = [
  'executor',
  'planner',
  'architect',
  'critic',
  'explore',
  'verifier',
  'code-reviewer',
  'debugger',
  'writer',
  'test-engineer',
];

// Personas whose manifest tools must never carry a write- or shell-mutation
// capable tool. Muse semantics: a child's tools may only narrow the inherited
// grant, never widen it, so a read-only persona that picks up `edit_file` or
// `write_file` (or unrestricted `bash`) has silently widened its own lane.
const READ_ONLY_PERSONA_IDS = ['architect', 'critic', 'explore', 'code-reviewer', 'verifier'];
// The read-only boundary is the filesystem, not the shell. A verifier that cannot
// run a test suite and a code-reviewer that cannot run `git diff` produce opinions
// rather than evidence, so read-only personas keep `bash` and their SOULs constrain
// it to inspection — the same split muse uses for its own approval reviewer.
const MUTATING_TOOLS = new Set(['edit_file', 'write_file']);

test('all 10 personas load and every expected id is present', () => {
  const personas = loadPersonas();
  assert.equal(personas.length, 10);
  const ids = personas.map((p) => p.id).sort();
  assert.deepEqual(ids, [...EXPECTED_IDS].sort());
});

test('every manifest tools array is non-empty', () => {
  for (const persona of loadPersonas()) {
    assert.ok(Array.isArray(persona.tools), `${persona.id}: tools must be an array`);
    assert.ok(persona.tools.length > 0, `${persona.id}: tools must be non-empty`);
  }
});

test('read-only personas do not carry write or mutation tools', () => {
  for (const id of READ_ONLY_PERSONA_IDS) {
    const persona = loadPersonas().find((p) => p.id === id);
    assert.ok(persona, `expected a persona for "${id}"`);
    for (const tool of persona.tools) {
      assert.ok(
        !MUTATING_TOOLS.has(tool),
        `${id} is read-only but declares mutating tool "${tool}"`,
      );
    }
  }
});

test('evidence-producing personas can actually run commands', () => {
  // Regression guard: verifier and code-reviewer were briefly shipped without
  // `bash`, which left them unable to run a test suite or `git diff` — reduced to
  // producing opinions instead of evidence, which defeats the persona.
  for (const id of ['verifier', 'code-reviewer']) {
    const persona = loadPersonas().find((p) => p.id === id);
    assert.ok(persona, `expected a persona for "${id}"`);
    assert.ok(
      persona.tools.includes('bash'),
      `${id} must be able to run inspection commands to produce evidence`,
    );
  }
});

test('every SOUL contains both required section headings', () => {
  for (const persona of loadPersonas()) {
    assert.match(
      persona.soul,
      /## How you work/,
      `${persona.id}: SOUL.md missing "## How you work"`,
    );
    assert.match(
      persona.soul,
      /## What you do not do/,
      `${persona.id}: SOUL.md missing "## What you do not do"`,
    );
  }
});

test('renderPersonaPrompt throws on an unknown id, naming valid ids', () => {
  assert.throws(
    () => renderPersonaPrompt('not-a-real-persona'),
    (err) => {
      assert.match(err.message, /Unknown persona "not-a-real-persona"/);
      for (const id of EXPECTED_IDS) {
        assert.ok(err.message.includes(id), `error message should name "${id}"`);
      }
      return true;
    },
  );
});

test('renderPersonaPrompt output contains the SOUL text', () => {
  for (const persona of loadPersonas()) {
    const rendered = renderPersonaPrompt(persona.id);
    assert.ok(
      rendered.includes(persona.soul),
      `renderPersonaPrompt("${persona.id}") should contain its SOUL body`,
    );
  }
});
