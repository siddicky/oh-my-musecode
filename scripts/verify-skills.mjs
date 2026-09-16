#!/usr/bin/env node
/**
 * Validates every skill in the corpus against the installed `muse` binary.
 *
 * This is the only trustworthy oracle for frontmatter conformance. `valid: true`
 * on its own is not enough: muse tolerates unknown frontmatter keys by recording
 * them in `compatibility.unknown_fields` and ignoring them at runtime. A skill
 * carrying `triggers:` or `pipeline:` therefore validates "successfully" while
 * behaving as if those fields were never written — so an empty unknown_fields
 * array is part of the pass condition, not a nicety.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(ROOT, 'skills');

/**
 * Evaluates one live `muse skills validate --json` report against the gate.
 *
 * `valid: true` alone is not enough: the CLI tolerates unknown frontmatter
 * keys by recording them in `compatibility.unknown_fields` and ignoring them
 * at runtime, so a non-empty `unknown_fields` (or `unsupported_fields`) fails
 * the skill even when `valid` is true. Exported for the field-classification
 * tests (test/verify-skills-fields.test.mjs), which feed it live-obtained
 * reports for fixture skills.
 *
 * @param {any} report parsed `skills validate --json` document
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function evaluateSkillReport(report) {
  const unknown = report?.compatibility?.unknown_fields ?? [];
  const unsupportedFields = report?.compatibility?.unsupported_fields ?? [];
  const unsupported = (report?.diagnostics ?? []).filter(
    (d) => d.code === 'unsupported-skill-field',
  );

  const problems = [];
  if (!report?.valid) problems.push('valid=false');
  if (unknown.length > 0) problems.push(`inert frontmatter keys: ${unknown.join(', ')}`);
  if (unsupportedFields.length > 0) {
    problems.push(`unsupported fields: ${unsupportedFields.join(', ')}`);
  }
  if (unsupported.length > 0) {
    problems.push(`unsupported fields: ${unsupported.map((d) => d.message).join('; ')}`);
  }
  return { ok: problems.length === 0, problems };
}

// CLI entry point. Guarded so importing `evaluateSkillReport` for tests does
// not re-run the whole gate as a side effect.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();

  if (skills.length === 0) {
    console.error('verify-skills: no skills found under skills/');
    process.exit(1);
  }

  let failures = 0;

  for (const name of skills) {
    const result = spawnSync('muse', ['skills', 'validate', join(SKILLS_DIR, name), '--json'], {
      encoding: 'utf8',
    });

    if (result.error) {
      console.error(`  ${name}: could not run muse (${result.error.message})`);
      failures++;
      continue;
    }

    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      console.error(`  ${name}: muse did not return parseable JSON`);
      failures++;
      continue;
    }

    const { ok, problems } = evaluateSkillReport(report);

    if (!ok) {
      console.error(`  ${name}: FAIL — ${problems.join(' | ')}`);
      failures++;
    } else {
      console.log(`  ${name}: ok`);
    }
  }

  if (failures > 0) {
    console.error(`\nverify-skills: ${failures} of ${skills.length} skills failed.`);
    process.exit(1);
  }

  console.log(`\nverify-skills: all ${skills.length} skills valid with no inert frontmatter.`);
}
