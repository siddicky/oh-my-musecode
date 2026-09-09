#!/usr/bin/env node
/**
 * oh-my-musecode installer.
 *
 * Two jobs:
 *   1. Register this repo as a plugin marketplace in a target workspace.
 *   2. Run an escalation preflight and report, honestly, which sandbox-escalation
 *      routes this muse build actually supports.
 *
 * On (2): the design originally called for a named `omm-critic` permission profile
 * so the external codex critic could escalate through a scoped, inspectable grant.
 * muse 1.0.3 cannot do that — `execution.permission_profiles` validates as
 * `field_not_activated` and `--permission-profile <id>` reports "profile does not
 * exist". Rather than write config the harness silently ignores, the installer
 * probes for the capability and tells the truth about what is left.
 *
 * Note on writing `.agents/`: muse protects that path from the *agent* (mediated
 * writes are held for review; sandboxed shell writes fail read-only). This
 * installer is user-run tooling outside a muse session, so the write is legitimate
 * — the guardrail binds the agent, not the human.
 *
 * Usage:
 *   node scripts/install.mjs [--workspace <path>] [--dry-run] [--config-dir <path>]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { escalationVerdict } from './preflight.mjs';
import { mergeSettings, readSettings, writeSettings } from './settings-install.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_NAME = 'oh-my-musecode';

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = { workspace: process.cwd(), dryRun: false, configDir: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--workspace':
        args.workspace = resolve(argv[++i] ?? '');
        break;
      case '--config-dir':
        args.configDir = resolve(argv[++i] ?? '');
        break;
      case '--help':
      case '-h':
        console.log(
          'Usage: node scripts/install.mjs [--workspace <path>] [--config-dir <path>] [--dry-run]',
        );
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function fail(message) {
  console.error(`oh-my-musecode install: ${message}`);
  process.exit(1);
}

function museConfigDir(override) {
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, 'muse') : join(homedir(), '.config', 'muse');
}

/**
 * Runs `muse` and returns a three-valued probe result.
 *
 * Status, signal and both streams are all preserved: an earlier version returned
 * only a string, so a crashed probe was indistinguishable from a clean "capability
 * present" answer and the preflight failed open.
 *
 * @returns {{ status: number | null, signal: string | null, output: string, ran: boolean }}
 */
function probe(args) {
  const result = spawnSync('muse', args, { encoding: 'utf8' });
  if (result.error) {
    return { status: null, signal: null, output: String(result.error.message ?? ''), ran: false };
  }
  return {
    status: result.status,
    signal: result.signal,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    ran: true,
  };
}

// ------------------------------------------------------- escalation preflight

/**
 * Determines what this muse build will actually allow for the external critic.
 * Parsing lives in ./preflight.mjs so these branches stay unit-testable without
 * an enterprise config document.
 */
function escalationPreflight() {
  return escalationVerdict({
    profileProbe: probe(['exec', '--provider', 'echo', '--permission-profile', '__omm_probe__', 'x']),
    configProbe: probe(['config', 'status']),
  });
}

// --------------------------------------------------------------- marketplace

/** Builds the marketplace registration this installer wants in place. */
function desiredMarketplace(existing, workspace) {
  // A relative source only helps when the plugin lives inside the workspace;
  // otherwise it degrades into ../../../.. chains that break if either moves.
  const rel = relative(workspace, PLUGIN_ROOT);
  const inside = rel !== '' && !rel.startsWith('..');
  const entry = {
    name: PLUGIN_NAME,
    source: rel === '' ? './' : inside ? `./${rel}` : PLUGIN_ROOT,
  };

  const base =
    existing && typeof existing === 'object'
      ? structuredClone(existing)
      : { name: 'workspace-plugins', plugins: [] };

  if (!Array.isArray(base.plugins)) base.plugins = [];

  const index = base.plugins.findIndex((p) => p?.name === PLUGIN_NAME);
  if (index >= 0) base.plugins[index] = { ...base.plugins[index], ...entry };
  else base.plugins.push(entry);

  return base;
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`${path} exists but is not valid JSON (${err.message}); refusing to overwrite it`);
  }
}

// ---------------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));

// The manifest gate runs first: registering a plugin whose manifest declares a
// rejected capability would install something that loads but does not work.
try {
  execFileSync('node', [join(PLUGIN_ROOT, 'scripts', 'verify-manifest.mjs')], { stdio: 'pipe' });
} catch (err) {
  fail(`manifest verification failed, refusing to install:\n${err.stdout?.toString() ?? err.message}`);
}

/**
 * True when this build's plugins subsystem is usable at all. On 1.0.3-R2198.1 it
 * is not: every `muse plugins` command answers "plugins are not available in this
 * build", and a registered marketplace yields no skills and no diagnostics. When
 * plugins are off, the manifest is inert and delivery has to go through settings.
 */
function pluginsSupported() {
  const result = probe(['plugins', '--help']);
  if (!result.ran) return false;
  return !/plugins are not available in this build|missing plugins command/i.test(result.output);
}

const preflight = escalationPreflight();
const pluginsOn = pluginsSupported();

if (preflight.blocked) {
  console.error('oh-my-musecode install: refusing to install.\n');
  for (const line of preflight.detail) console.error(`  - ${line}`);
  console.error('');

  if (preflight.blockReason === 'policy-forbids-bypass') {
    console.error('  Enterprise policy sets execution.forbid_sandbox_bypass.');
    console.error('  muse 1.0.3 offers no named permission profile to scope an escalation, so');
    console.error('  --disable-sandbox is the only route an external codex/claude critic has,');
    console.error('  and this policy forbids it. The external critic cannot run here.\n');
    console.error('  Re-run without the external critic, or use the in-harness critic persona.');
  } else {
    console.error('  The escalation posture could not be determined: a `muse` probe did not');
    console.error('  complete cleanly. Refusing rather than guessing, because guessing here');
    console.error('  means guessing permissively.\n');
    console.error('  Check that `muse` is on PATH and runnable, then re-run.');
  }
  process.exit(1);
}

const settingsPath = join(museConfigDir(args.configDir), 'settings.json');

console.log(`oh-my-musecode ${args.dryRun ? '(dry run)' : 'install'}`);
console.log(`  plugin root: ${PLUGIN_ROOT}`);
console.log(`  workspace:   ${args.workspace}`);
console.log(`  config dir:  ${museConfigDir(args.configDir)}`);
console.log('');
console.log('Escalation preflight:');
for (const line of preflight.detail) console.log(`  - ${line}`);
console.log('');

if (pluginsOn) {
  // Forward-looking path: this build can load the native manifest directly.
  const marketplacePath = join(args.workspace, '.agents', 'plugins', 'marketplace.json');
  const existing = readJsonIfPresent(marketplacePath);
  const desired = desiredMarketplace(existing, args.workspace);
  const nextContents = JSON.stringify(desired, null, 2) + '\n';
  const changed = (existing ? readFileSync(marketplacePath, 'utf8') : null) !== nextContents;

  console.log('Delivery: plugin marketplace (this build supports plugins).');
  if (args.dryRun) {
    console.log(changed ? `  Would write ${marketplacePath}` : `  ${marketplacePath} already current.`);
  } else if (changed) {
    mkdirSync(dirname(marketplacePath), { recursive: true });
    writeFileSync(marketplacePath, nextContents, 'utf8');
    console.log(`  Registered ${marketplacePath}`);
  } else {
    console.log(`  ${marketplacePath} already current.`);
  }
} else {
  console.log('Delivery: muse settings (this build reports "plugins are not available").');
  console.log('  The plugin manifest is kept for builds that enable plugins, but it');
  console.log('  delivers nothing here, so skills, hooks and the MCP server are');
  console.log('  installed through routes verified to work on this build.');
  console.log('');

  // 1. Skills, via the documented installer.
  const skillIds = readdirSync(join(PLUGIN_ROOT, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  console.log(`  Skills (${skillIds.length}) -> muse skills install --scope user:`);
  for (const id of skillIds) {
    if (args.dryRun) {
      console.log(`    would install ${id}`);
      continue;
    }
    const result = probe(['skills', 'install', join(PLUGIN_ROOT, 'skills', id), '--scope', 'user', '--force', '--json']);
    if (!result.ran || result.status !== 0) {
      fail(`installing skill ${id} failed:\n${result.output}`);
    }
    console.log(`    installed ${id}`);
  }

  // 2. Hooks + MCP server, via settings.json.
  let current;
  try {
    current = readSettings(settingsPath);
  } catch (err) {
    fail(`${settingsPath} exists but is not valid JSON (${err.message}); refusing to overwrite it`);
  }
  const merged = mergeSettings(current, PLUGIN_ROOT);
  const mergedContents = JSON.stringify(merged, null, 2) + '\n';
  const currentContents = current ? readFileSync(settingsPath, 'utf8') : null;

  console.log('');
  if (args.dryRun) {
    console.log(
      currentContents === mergedContents
        ? `  ${settingsPath} already current.`
        : `  Would merge hooks + mcpServers into ${settingsPath}`,
    );
  } else if (currentContents !== mergedContents) {
    writeSettings(settingsPath, merged);
    console.log(`  Merged hooks + mcpServers into ${settingsPath}`);
  } else {
    console.log(`  ${settingsPath} already current.`);
  }
}

console.log('');
console.log('External critic posture (read this before using --critic=codex):');
if (preflight.namedProfiles === 'yes') {
  console.log('  Named permission profiles are available on this build; prefer scoping');
  console.log('  the escalation to a profile over --disable-sandbox.');
} else {
  console.log('  This build cannot create a named permission profile, so the escalation');
  console.log('  CANNOT be scoped to the critic call. Running an external codex/claude');
  console.log('  critic requires launching the whole session with:');
  console.log('');
  console.log('      muse --disable-sandbox');
  console.log('');
  console.log('  That removes filesystem and network sandboxing for EVERYTHING in the');
  console.log('  session, not just the critic. It also puts the critic\'s work outside');
  console.log('  muse\'s append-only audit trail. Both are real costs of cross-model');
  console.log('  review; the in-harness critic persona keeps full containment instead.');
}
console.log('');
console.log('Next: trust the workspace, then confirm the skills are visible with');
console.log('`muse skills list --source all`.');
