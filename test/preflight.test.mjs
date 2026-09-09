import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  namedProfilesAvailable,
  parseConfigStatus,
  escalationVerdict,
} from '../scripts/preflight.mjs';

/** Builds a probe result for a process that ran and exited cleanly. */
const ok = (output) => ({ status: 0, signal: null, output, ran: true });
/** A process that ran but failed. */
const failed = (output, status = 2) => ({ status, signal: null, output, ran: true });
/** A process that never started (muse missing from PATH). */
const didNotRun = { status: null, signal: null, output: 'ENOENT', ran: false };

// Verbatim muse 1.0.3 output, so these fail if the CLI's wording changes.
const PROFILE_MISSING = "Permission profile 'omm-critic' is unavailable: profile does not exist.\n";
const NO_PROFILES = 'Named permission profiles are unavailable: no permission profile is available.';

const STATUS_NO_POLICY = `Enterprise configuration status
Generation: sha256:927c2e7d
Sources:
  plane=defaults source_class=system_file state=absent
  plane=policy source_class=system_file state=absent
  plane=policy source_class=macos_managed_preferences state=absent`;

const STATUS_POLICY_LOCKED = `Enterprise configuration status
Sources:
  plane=policy source_class=system_file state=valid
Active policy:
  execution.forbid_sandbox_bypass = true`;

const STATUS_POLICY_UNLOCKED = `Enterprise configuration status
Sources:
  plane=policy source_class=system_file state=valid
Active policy:
  execution.approval_modes = on_request`;

test('an explicit refusal is a definite no', () => {
  assert.equal(namedProfilesAvailable(ok(PROFILE_MISSING)), 'no');
  assert.equal(namedProfilesAvailable(failed(NO_PROFILES)), 'no');
});

test('a probe that never ran is unknown, not available', () => {
  assert.equal(namedProfilesAvailable(didNotRun), 'unknown');
  assert.equal(namedProfilesAvailable(null), 'unknown');
});

test('a crashed probe is unknown, not available', () => {
  // codex reproduction: a fake muse printing "fatal: probe crashed", exit 2,
  // previously read as "profiles available".
  assert.equal(namedProfilesAvailable(failed('fatal: probe crashed')), 'unknown');
});

test('a signal-killed probe is unknown', () => {
  assert.equal(
    namedProfilesAvailable({ status: null, signal: 'SIGKILL', output: '', ran: true }),
    'unknown',
  );
});

test('a clean exit with no complaint counts as available', () => {
  assert.equal(namedProfilesAvailable(ok('echo: x\n')), 'yes');
});

test('an all-absent policy plane is definitely absent', () => {
  const parsed = parseConfigStatus(ok(STATUS_NO_POLICY));
  assert.equal(parsed.policyPresent, 'no');
  assert.equal(parsed.sandboxBypassForbidden, 'no');
});

test('a present policy plane forbidding sandbox bypass is detected', () => {
  const parsed = parseConfigStatus(ok(STATUS_POLICY_LOCKED));
  assert.equal(parsed.policyPresent, 'yes');
  assert.equal(parsed.sandboxBypassForbidden, 'yes');
});

test('a present policy plane without the lock does not block', () => {
  const parsed = parseConfigStatus(ok(STATUS_POLICY_UNLOCKED));
  assert.equal(parsed.policyPresent, 'yes');
  assert.equal(parsed.sandboxBypassForbidden, 'no');
});

test('unreadable or unrecognised config status is unknown, not absent', () => {
  assert.equal(parseConfigStatus(failed('fatal: probe crashed')).policyPresent, 'unknown');
  assert.equal(parseConfigStatus(didNotRun).policyPresent, 'unknown');
  assert.equal(parseConfigStatus(ok('')).policyPresent, 'unknown');
  assert.equal(parseConfigStatus(ok('some unrelated output')).policyPresent, 'unknown');
});

test('verdict blocks when policy forbids the only escalation route', () => {
  const verdict = escalationVerdict({
    profileProbe: ok(PROFILE_MISSING),
    configProbe: ok(STATUS_POLICY_LOCKED),
  });
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.blockReason, 'policy-forbids-bypass');
});

test('verdict blocks when the posture cannot be determined', () => {
  // The fail-open case: refusing is the only safe answer.
  const verdict = escalationVerdict({
    profileProbe: failed('fatal: probe crashed'),
    configProbe: failed('fatal: probe crashed'),
  });
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.blockReason, 'posture-undetermined');
  assert.ok(verdict.detail.some((line) => /UNKNOWN/.test(line)));
});

test('verdict blocks when muse is missing entirely', () => {
  const verdict = escalationVerdict({ profileProbe: didNotRun, configProbe: didNotRun });
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.blockReason, 'posture-undetermined');
});

test('verdict permits installation on a readable, unlocked build', () => {
  const verdict = escalationVerdict({
    profileProbe: ok(PROFILE_MISSING),
    configProbe: ok(STATUS_NO_POLICY),
  });
  assert.equal(verdict.blocked, false);
  assert.equal(verdict.blockReason, null);
  assert.ok(verdict.detail.some((line) => /unavailable on this build/.test(line)));
});
