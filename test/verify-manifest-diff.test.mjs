/**
 * Executable ACCEPTED/REJECTED diff: `scripts/verify-manifest.mjs` verdicts
 * against live `muse plugins validate --json` on the same fixtures.
 *
 * The two agree on the ACCEPTED fixture (both valid). They deliberately
 * DIVERGE on the agents fixture: the live 1.3.0 validator reports
 * valid-with-`unsupported-capability`-warning ("not supported in this
 * phase") while our gate fails closed — shipping definitions the runtime
 * ignores must not wear a green badge (see the header note on deliberate
 * strictness). This test pins both halves so the divergence stays a
 * decision, never drift.
 *
 * Live-binary assertions skip when `muse` is not on PATH; the script-verdict
 * assertions always run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'verify-manifest.mjs');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'verify-manifest');

function runScript(fixture) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, OMM_VERIFY_ROOT: join(FIXTURES, fixture) },
  });
}

function museAvailable() {
  const probe = spawnSync('muse', ['--version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
}

function liveValidate(fixture) {
  const result = spawnSync('muse', ['plugins', 'validate', join(FIXTURES, fixture), '--json'], {
    encoding: 'utf8',
  });
  if (result.error) return null;
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

test('ACCEPTED fixture: script and live binary agree (valid)', () => {
  const scripted = runScript('accepted');
  assert.equal(scripted.status, 0, scripted.stderr);

  if (!museAvailable()) {
    console.log('  (skip: muse not on PATH — live half of the diff)');
    return;
  }
  const live = liveValidate('accepted');
  assert.ok(live, 'live validate must return parseable JSON');
  assert.equal(live.valid, true, JSON.stringify(live.diagnostics ?? live));
});

test('agents fixture: script fails closed where live only warns (pinned divergence)', () => {
  const scripted = runScript('agents-rejected');
  assert.notEqual(scripted.status, 0, 'the gate must reject the agents capability');
  assert.match(scripted.stderr, /capability `agents` is rejected by this gate/);

  if (!museAvailable()) {
    console.log('  (skip: muse not on PATH — live half of the diff)');
    return;
  }
  const live = liveValidate('agents-rejected');
  assert.ok(live, 'live validate must return parseable JSON');
  assert.equal(live.valid, true, 'live 1.3.0 accepts agents with a warning, not an error');
  const codes = (live.diagnostics ?? []).map((d) => d.code);
  assert.ok(
    codes.includes('unsupported-capability'),
    `live must warn unsupported-capability, got: ${JSON.stringify(codes)}`,
  );
});

test('bogus hook event fails the gate (PostToolUseFailure is allowlisted, not anything-goes)', () => {
  const scripted = runScript('bogus-event');
  assert.notEqual(scripted.status, 0, 'unknown hook events must fail');
  assert.match(scripted.stderr, /unsupported event "MadeUpEvent"/);
});
