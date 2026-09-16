/**
 * Marketplace plugin-route logic (`muse plugins install/approve/enable`, plus
 * uninstall and doctor support for the same route).
 *
 * Everything here takes an injected `runMuse(args)` (`{ status, output }`)
 * rather than spawning `muse` directly, so the route is unit-testable with a
 * stub and integration-testable against `test/helpers/fake-muse.mjs` in
 * plugins-on mode. Printing goes through an injected `log` for the same reason.
 *
 * Route rationale (probed against Muse 1.3.0-R3057.1, see US-002 notes):
 * writing `.agents/plugins/marketplace.json` by hand is NOT honored — with
 * such a file present `plugins list --available` still reports
 * `{"available":[]}`, and `marketplace add` only registers a source that
 * already contains a catalog. The supported route is a direct
 * `plugins install <bundle> --scope user --json` (the CLI copies the package
 * into its own cache, so the staged source needs no durability), followed by
 * `plugins approve <id>` (trusts the hook + mcp runtime capabilities) and
 * `plugins enable <id>`. The bundle comes from `stagePluginBundle`, never the
 * raw repo root: symlinks and an unbounded inventory both fail validation.
 */

import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stagePluginBundle } from './plugin-bundle.mjs';

/**
 * Extracts the JSON document from `muse --json` output, tolerating the
 * trailing human-readable line the CLI appends after error payloads.
 * Returns `null` when no JSON object can be found.
 *
 * @param {string} output combined stdout + stderr
 * @returns {any} parsed document or null
 */
export function parseJsonDocument(output) {
  const text = String(output ?? '');
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

/**
 * Finds our plugin's record in `plugins list --json` output.
 *
 * @param {any} doc parsed list document
 * @param {string} pluginName
 * @returns {{ id: string, enabled: boolean, version: string, cachePath: string | null } | null}
 */
export function findPluginRecord(doc, pluginName) {
  const entries = doc?.plugins ?? [];
  for (const entry of entries) {
    const record = entry?.record ?? entry;
    if (record?.id === pluginName) {
      return {
        id: record.id,
        enabled: record.enabled === true,
        version: record.version ?? null,
        cachePath: record.cache_path ?? record.cachePath ?? null,
      };
    }
  }
  return null;
}

/**
 * Installs via the marketplace route: stage, live-validate, install,
 * approve, enable. Throws on any step that does not confirm success —
 * an unconfirmed install must never read as done.
 */
export function installPluginRoute({
  runMuse,
  pluginRoot,
  pluginName,
  scope = 'user',
  dryRun = false,
  log = console.log,
}) {
  if (dryRun) {
    log('Delivery: plugin marketplace (this build supports plugins).');
    log(`  Would stage a plugin bundle from ${pluginRoot} and run:`);
    log(`    muse plugins install <bundle> --scope ${scope} --json`);
    log(`    muse plugins approve ${pluginName} --json`);
    log(`    muse plugins enable ${pluginName} --json`);
    return { dryRun: true, pluginId: null };
  }

  const staging = mkdtempSync(join(tmpdir(), 'omm-plugin-bundle-'));
  try {
    const { version, prunedFiles } = stagePluginBundle(pluginRoot, staging);
    log('Delivery: plugin marketplace (this build supports plugins).');
    log(`  Staged bundle ${version} (${prunedFiles} non-runtime files pruned)`);

    const validated = runMuse(['plugins', 'validate', staging, '--json']);
    const validDoc = parseJsonDocument(validated.output);
    if (!validDoc || validDoc.valid !== true) {
      throw new Error(
        `staged bundle failed live validation, refusing to install:\n${validated.output}`,
      );
    }
    log('  Bundle validates against the live binary');

    const installed = runMuse(['plugins', 'install', staging, '--scope', scope, '--json']);
    const installedDoc = parseJsonDocument(installed.output);
    const pluginId = installedDoc?.installed?.id;
    if (installed.status !== 0 || pluginId !== pluginName) {
      throw new Error(`muse plugins install failed:\n${installed.output}`);
    }
    log(`  Installed ${pluginId} ${installedDoc.installed.version ?? ''}`.trimEnd());

    const approved = runMuse(['plugins', 'approve', pluginId, '--json']);
    const approvedDoc = parseJsonDocument(approved.output);
    if (approvedDoc?.decision === 'approve') {
      const caps = approvedDoc.runtime_capabilities ?? [];
      log(`  Approved ${caps.length} runtime capabilities`);
    } else if (approvedDoc?.error?.code === 'runtime-capability-not-found') {
      // A capabilities set with no runtime capabilities (skills-only) has
      // nothing to approve — the live CLI reports this as an error payload,
      // which is a successful no-op, not a failure.
      log('  Approved 0 runtime capabilities (none to approve)');
    } else {
      throw new Error(`muse plugins approve failed:\n${approved.output}`);
    }

    const enabled = runMuse(['plugins', 'enable', pluginId, '--json']);
    const enabledDoc = parseJsonDocument(enabled.output);
    if (enabled.status !== 0 || enabledDoc?.enable?.id !== pluginId) {
      throw new Error(`muse plugins enable failed:\n${enabled.output}`);
    }
    log(`  Enabled ${pluginId}`);

    return { dryRun: false, pluginId, version };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Removes the plugin record installed by the marketplace route. Succeeds
 * when nothing is installed (second run exits clean, per the PRD).
 */
export function uninstallPluginRoute({ runMuse, pluginName, log = console.log }) {
  const listed = runMuse(['plugins', 'list', '--json']);
  const record = findPluginRecord(parseJsonDocument(listed.output), pluginName);
  if (!record) {
    log(`  ${pluginName}: not installed via the marketplace route; nothing to remove.`);
    return { removed: false };
  }
  const removed = runMuse(['plugins', 'remove', pluginName, '--json']);
  const removedDoc = parseJsonDocument(removed.output);
  if (removed.status !== 0 || (removedDoc?.removed !== undefined && removedDoc.removed !== pluginName)) {
    throw new Error(`muse plugins remove failed:\n${removed.output}`);
  }
  log(`  Removed plugin record ${pluginName}`);
  return { removed: true };
}

/**
 * Doctor checks for the marketplace route, shaped like doctor.mjs checks
 * (`{ name, ok, detail }`) so the same reporter renders them.
 */
export async function doctorPluginRoute({
  runMuse,
  pluginName,
  version,
  expectedSkillIds,
  workspace,
  probeMcp,
  log = console.log,
}) {
  void log;
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    return ok;
  };

  const listed = runMuse(['plugins', 'list', '--json']);
  const record = findPluginRecord(parseJsonDocument(listed.output), pluginName);
  if (!check('plugin installed', !!record, record ? `${record.id} ${record.version ?? ''}`.trimEnd() : `${pluginName} is not in muse plugins list`)) {
    return checks;
  }
  check('plugin enabled', record.enabled, record.enabled ? `${record.id} is enabled` : `${record.id} is installed but disabled; run ${pluginName} install again to re-enable`);

  const inspected = runMuse(['plugins', 'inspect', pluginName, '--json']);
  const inspectDoc = parseJsonDocument(inspected.output);
  const inspectOk =
    inspectDoc?.valid === true &&
    inspectDoc?.active === true &&
    (inspectDoc?.record?.version ?? inspectDoc?.plugin?.version) === version;
  check(
    'plugin valid and active',
    inspectOk,
    inspectOk
      ? `version ${version}, active`
      : `expected valid+active at version ${version}; inspect reported: ${inspected.output.slice(0, 200)}`,
  );

  const skillsListed = runMuse(['skills', 'list', '--source', 'plugin', '--json']);
  const skillsDoc = parseJsonDocument(skillsListed.output);
  const visibleIds = new Set((skillsDoc?.skills ?? []).map((s) => s.id ?? s.name));
  const missing = (expectedSkillIds ?? []).filter(
    (id) => !visibleIds.has(id) && ![...visibleIds].some((v) => v === id || v.endsWith(`:${id}`)),
  );
  check(
    'skills visible',
    missing.length === 0,
    missing.length === 0
      ? `${expectedSkillIds.length}/${expectedSkillIds.length} visible (scope: plugin)`
      : `missing: ${missing.join(', ')}`,
  );

  const cachePath = record.cachePath ?? inspectDoc?.record?.cache_path ?? null;
  const entryPath = cachePath ? join(cachePath, 'dist', 'mcp', 'state-server.js') : null;
  if (!entryPath || !existsSync(entryPath)) {
    check(
      'mcp server spawns',
      false,
      entryPath
        ? `entry point does not exist: ${entryPath}`
        : 'no cache path reported for the installed plugin',
    );
  } else {
    checks.push(await probeMcp('node', entryPath, workspace));
  }

  return checks;
}
