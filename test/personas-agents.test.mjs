/**
 * `--agents` overlay vs personas (US-005): the overlay is explicitly NOT
 * integrated (see the US-005 verdict in src/personas.ts and
 * docs/live-probes-1.3.0.md). These tests pin that decision from three
 * sides: the rejection rationale is present in the source, no rendered
 * persona prompt emits `--agents` (or sibling session-startup) flags, and
 * the committed probe note covers every flag the PRD names.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPersonas, renderPersonaPrompt } from '../dist/personas.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('personas.ts carries the explicit --agents rejection with rationale', () => {
  const source = readFileSync(join(ROOT, 'src', 'personas.ts'), 'utf8');
  assert.match(source, /--agents/, 'must name the overlay flag');
  assert.match(source, /US-005 verdict/, 'must cite the deciding story');
  assert.match(source, /docs\/live-probes-1\.3\.0\.md/, 'must cite the probe evidence');
  assert.match(source, /subagent_spawn\(role, objective\)/, 'must state the operating layer');
});

test('no rendered persona prompt emits session-startup flags', () => {
  for (const persona of loadPersonas()) {
    const prompt = renderPersonaPrompt(persona.id);
    for (const flag of ['--agents', '--preset', '--permission-profile', '--disable-sandbox']) {
      assert.ok(
        !prompt.includes(flag),
        `persona ${persona.id} must not emit ${flag} (no flag-passing layer exists at dispatch)`,
      );
    }
  }
});

test('the probe note states every PRD-named flag present or missing', () => {
  const notePath = join(ROOT, 'docs', 'live-probes-1.3.0.md');
  assert.ok(existsSync(notePath), 'committed probe evidence must exist');
  const note = readFileSync(notePath, 'utf8');
  for (const flag of ['--agents', '--preset', 'ultra', '--subagent-worktree-isolation']) {
    assert.ok(note.includes(flag), `probe note must state ${flag} present/missing`);
  }
  assert.match(note, /1\.3\.0-R3057\.1/, 'probe note must name the build it was captured from');

  const helpPath = join(ROOT, 'test', 'fixtures', 'live-help-1.3.0.txt');
  assert.ok(existsSync(helpPath), 'full live --help output must be committed');
  const help = readFileSync(helpPath, 'utf8');
  assert.match(help, /--agents <JSON>/, 'committed help must carry the overlay flag');
  assert.ok(help.split('\n').length > 90, 'committed help must be the full output, not a summary');
});

test('the live binary still documents --agents (note is not stale)', () => {
  const probe = spawnSync('muse', ['--help'], { encoding: 'utf8' });
  if (probe.error) {
    console.log('  (skip: muse not on PATH)');
    return;
  }
  assert.match(probe.stdout, /--agents <JSON>/, 'live --help must still carry the overlay flag');
});
