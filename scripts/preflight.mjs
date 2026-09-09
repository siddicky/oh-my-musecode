/**
 * Pure escalation-preflight logic, separated from the installer so the
 * security-relevant branches are testable without an enterprise config document.
 *
 * Enterprise policy can only arrive from a system file or macOS managed
 * preferences, neither of which a test can create. Keeping the parsing pure means
 * the "refuse to install" path is covered by tests rather than by hope.
 *
 * Every probe is three-valued — yes / no / unknown. An earlier version collapsed
 * unknown into "available" and "policy absent", so a crashed or missing `muse`
 * made the installer report a *more* permissive posture than reality. A safety
 * preflight must fail closed, so an indeterminate probe now blocks installation
 * rather than being read as good news.
 */

/** @typedef {'yes' | 'no' | 'unknown'} Tri */

/**
 * @typedef {object} ProbeResult
 * @property {number | null} status exit code, or null if the process never ran
 * @property {string | null} signal terminating signal, if any
 * @property {string} output combined stdout + stderr
 * @property {boolean} ran whether the process actually started
 */

/**
 * Classifies whether named permission profiles are usable.
 *
 * @param {ProbeResult | null} probe
 * @returns {Tri}
 */
export function namedProfilesAvailable(probe) {
  if (!probe || !probe.ran || probe.signal) return 'unknown';

  // An explicit refusal is a definite "no" whatever the exit code.
  if (
    /profile does not exist|permission profiles? .*(is |are )?unavailable|no permission profile/i.test(
      probe.output,
    )
  ) {
    return 'no';
  }

  // Anything other than a clean exit tells us nothing about the capability.
  if (probe.status !== 0) return 'unknown';

  return 'yes';
}

/**
 * Parses `muse config status` output.
 *
 * @param {ProbeResult | null} probe
 * @returns {{ policyPresent: Tri, sandboxBypassForbidden: Tri }}
 */
export function parseConfigStatus(probe) {
  if (!probe || !probe.ran || probe.signal || probe.status !== 0 || !probe.output.trim()) {
    return { policyPresent: 'unknown', sandboxBypassForbidden: 'unknown' };
  }

  // A recognisable status document must actually mention the planes; anything
  // else is output we do not understand and must not interpret.
  if (!/plane=(defaults|policy)\b/.test(probe.output)) {
    return { policyPresent: 'unknown', sandboxBypassForbidden: 'unknown' };
  }

  const policyPresent = probe.output
    .split('\n')
    .some((line) => /plane=policy\b/.test(line) && !/\bstate=absent\b/.test(line));

  if (!policyPresent) return { policyPresent: 'no', sandboxBypassForbidden: 'no' };

  return {
    policyPresent: 'yes',
    sandboxBypassForbidden: /forbid_sandbox_bypass/i.test(probe.output) ? 'yes' : 'no',
  };
}

/**
 * Combines both probes into the verdict the installer acts on.
 *
 * `blocked` is true when installation must not proceed: either policy definitely
 * forbids the only escalation route, or the posture could not be determined at
 * all. `blockReason` explains which.
 *
 * @param {{ profileProbe: ProbeResult | null, configProbe: ProbeResult | null }} probes
 */
export function escalationVerdict({ profileProbe, configProbe }) {
  const namedProfiles = namedProfilesAvailable(profileProbe);
  const { policyPresent, sandboxBypassForbidden } = parseConfigStatus(configProbe);

  const describe = {
    yes: 'AVAILABLE',
    no: 'unavailable on this build (cannot scope the escalation)',
    unknown: 'UNKNOWN — could not determine (probe failed)',
  };

  const detail = [`named permission profiles: ${describe[namedProfiles]}`];
  if (policyPresent === 'unknown') {
    detail.push('enterprise policy: UNKNOWN — could not read `muse config status`');
  } else if (policyPresent === 'no') {
    detail.push('enterprise policy: absent (no forbid_sandbox_bypass lock)');
  } else {
    detail.push(
      `enterprise policy: present${sandboxBypassForbidden === 'yes' ? ' and forbids sandbox bypass' : ''}`,
    );
  }

  let blocked = false;
  let blockReason = null;

  if (sandboxBypassForbidden === 'yes') {
    blocked = true;
    blockReason = 'policy-forbids-bypass';
  } else if (policyPresent === 'unknown' || namedProfiles === 'unknown') {
    blocked = true;
    blockReason = 'posture-undetermined';
  }

  return { namedProfiles, policyPresent, sandboxBypassForbidden, detail, blocked, blockReason };
}
