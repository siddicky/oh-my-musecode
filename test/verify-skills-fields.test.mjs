/**
 * Skill field-classification tests: `profile`, `allowed_tools` (underscore),
 * and unknown top-level frontmatter must be rejected as inert, with a
 * diagnostic naming each field — while the 8 staged skills keep passing.
 *
 * Field reports come from the live `muse skills validate --json` (skipped
 * when `muse` is not on PATH) and are judged by the same
 * `evaluateSkillReport` the `verify:skills` gate uses, so the test proves the
 * gate's verdict rather than reimplementing it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateSkillReport } from '../scripts/verify-skills.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function museAvailable() {
  const probe = spawnSync('muse', ['--version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

function liveSkillReport(skillDir) {
  const result = spawnSync('muse', ['skills', 'validate', skillDir, '--json'], { encoding: 'utf8' });
  if (result.error) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function makeFixtureSkill(frontmatter) {
  const dir = mkdtempSync(join(tmpdir(), 'omm-skill-field-'));
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n# Fixture\n`);
  return dir;
}

test('evaluator rejects profile, allowed_tools, and unknown fields by name', () => {
  if (!museAvailable()) {
    console.log('  (skip: muse not on PATH — needs live field classification)');
    return;
  }
  const dir = makeFixtureSkill(
    'name: field-fixture\ndescription: Fixture skill.\nprofile: restricted\nallowed_tools:\n  - read_file\nbogus_field: true',
  );
  try {
    const report = liveSkillReport(dir);
    assert.ok(report, 'live validate must return parseable JSON');
    assert.equal(report.valid, true, 'the live CLI tolerates these fields (that is the hazard)');
    const { ok, problems } = evaluateSkillReport(report);
    assert.equal(ok, false, 'the gate must reject inert fields');
    const joined = problems.join(' | ');
    assert.match(joined, /profile/, 'diagnostic must name profile');
    assert.match(joined, /allowed_tools/, 'diagnostic must name allowed_tools');
    assert.match(joined, /bogus_field/, 'diagnostic must name the unknown field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluator fails a report carrying unsupported_fields', () => {
  const { ok, problems } = evaluateSkillReport({
    valid: true,
    compatibility: { known_fields: ['name'], unknown_fields: [], unsupported_fields: ['future-field'] },
    diagnostics: [],
  });
  assert.equal(ok, false);
  assert.match(problems.join(' | '), /future-field/);
});

test('evaluator fails unsupported-skill-field diagnostics', () => {
  const { ok, problems } = evaluateSkillReport({
    valid: true,
    compatibility: { known_fields: ['name'], unknown_fields: [], unsupported_fields: [] },
    diagnostics: [{ code: 'unsupported-skill-field', message: 'field `x` is not supported' }],
  });
  assert.equal(ok, false);
  assert.match(problems.join(' | '), /not supported/);
});

test('the 8 staged skills pass the evaluator against live reports', () => {
  if (!museAvailable()) {
    console.log('  (skip: muse not on PATH — needs live field classification)');
    return;
  }
  const skills = ['cancel', 'deep-dive', 'deep-interview', 'ralph', 'ralplan', 'team', 'trace', 'workflow'];
  for (const name of skills) {
    const report = liveSkillReport(join(ROOT, 'skills', name));
    assert.ok(report, `${name}: live validate must return parseable JSON`);
    const { ok, problems } = evaluateSkillReport(report);
    assert.equal(ok, true, `${name}: must pass, got: ${problems.join(' | ')}`);
  }
});
