#!/usr/bin/env node
/**
 * oh-my-musecode installer.
 *
 * Three verbs:
 *   install    — copy the harness into a stable home and register it in muse settings
 *   uninstall  — remove those settings entries and delete the stable home
 *   doctor     — verify an install actually works (hooks resolve, mcp responds, skills visible)
 *
 * On escalation: the design originally called for a named `omm-critic` permission
 * profile so the external codex critic could escalate through a scoped,
 * inspectable grant. On builds through 1.1.1 muse could not do that, so
 * rather than write config the harness silently ignores, the installer
 * probes for the capability and tells the truth about what is left.
 * Muse 1.3.0-R3057.1 ships a real `--permission-profile` flag, but no
 * profile is defined by default (the probe reports `profile does not
 * exist`) and the enterprise-config shape that defines one is unconfirmed —
 * so scoping still depends on the preflight result below.
 *
 * On the stable home: this script runs from wherever npm/npx placed the
 * package. Under `npx` that is a prunable cache directory
 * (`~/.npm/_npx/<hash>/...`), so `install` copies the runtime (hooks, dist,
 * personas, and the resolved production dependency closure) into a versioned,
 * durable home under the muse config directory and points settings.json
 * there instead — see scripts/stable-home.mjs.
 *
 * Note on writing `.agents/`: muse protects that path from the *agent*
 * (mediated writes are held for review; sandboxed shell writes fail
 * read-only). This installer is user-run tooling outside a muse session, so
 * the write is legitimate — the guardrail binds the agent, not the human.
 *
 * Usage:
 *   node scripts/install.mjs install [--workspace <path>] [--config-dir <path>] [--dry-run]
 *   node scripts/install.mjs uninstall [--config-dir <path>] [--purge]
 *   node scripts/install.mjs doctor [--workspace <path>] [--config-dir <path>]
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { escalationVerdict } from './preflight.mjs';
import { doctorPluginRoute, installPluginRoute, uninstallPluginRoute } from './plugin-route.mjs';
import { mergeSettings, readSettings, writeSettings, unmergeSettings } from './settings-install.mjs';
import {
  installStableHome,
  installedStableHomes,
  readInstallManifest,
  referencedStableHomes,
  removeAllStableHomes,
  resolveHomeParent,
  resolveStableHome,
} from './stable-home.mjs';
// `doctor.mjs` imports the MCP SDK client, a runtime dependency. It is loaded
// dynamically, only inside the `doctor` verb (below), so `install`/
// `uninstall`/`--help`/`--version` never require that dependency to be
// resolvable — e.g. a freshly `npm pack`-extracted tarball with no
// `node_modules` yet can still run `install` (which is what actually fetches
// dependencies via muse/npm in the first place) without this module load
// failing before argument parsing even happens.

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_NAME = 'oh-my-musecode';
const BIN_NAME = 'oh-my-musecode';
const VERBS = ['install', 'uninstall', 'doctor'];

function pkgVersion() {
  return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version;
}

// ---------------------------------------------------------------- arguments

function printHelp() {
  console.log(`Usage: ${BIN_NAME} <install|uninstall|doctor> [options]

  install    Install the harness: marketplace plugin route when supported,
             else a stable home plus muse settings
             [--workspace <path>] [--config-dir <path>] [--dry-run]

  uninstall  Remove the installed harness: plugin record plus muse settings
             entries and the installed runtime
             [--config-dir <path>] [--purge]  (--purge also removes the installed skills)

  doctor     Verify hooks resolve, the mcp server responds, and skills are visible
             [--workspace <path>] [--config-dir <path>]

Global:
  -h, --help       Show this help
  -V, --version    Print the installed package version`);
}

function parseArgs(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') {
    printHelp();
    process.exit(0);
  }
  if (argv[0] === '--version' || argv[0] === '-V') {
    console.log(pkgVersion());
    process.exit(0);
  }

  const verb = argv[0];
  if (!verb || verb.startsWith('-')) {
    fail(
      `a command is required.\n  Did you mean:  ${BIN_NAME} install${argv.length ? ' ' + argv.join(' ') : ''}\n` +
        `Run \`${BIN_NAME} --help\` for usage.`,
    );
  }
  if (!VERBS.includes(verb)) {
    fail(`unknown command "${verb}". Valid commands are: ${VERBS.join(', ')}.`);
  }

  const args = { verb, workspace: process.cwd(), dryRun: false, configDir: null, purge: false };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    switch (rest[i]) {
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--purge':
        args.purge = true;
        break;
      case '--workspace':
        args.workspace = resolve(rest[++i] ?? '');
        break;
      case '--config-dir':
        args.configDir = resolve(rest[++i] ?? '');
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break; // eslint-friendly; process.exit never returns
      default:
        fail(`unknown argument: ${rest[i]}`);
    }
  }
  return args;
}

function fail(message) {
  console.error(`${BIN_NAME}: ${message}`);
  process.exit(1);
}

/**
 * `--config-dir` is the value that would otherwise come from `XDG_CONFIG_HOME`
 * (muse resolves its own config dir as `$XDG_CONFIG_HOME/muse`, or
 * `~/.config/muse` when that is unset), NOT the final muse config directory
 * itself. This is the only shape that lets `--config-dir` actually isolate
 * every `muse` subprocess this script spawns (skills install/uninstall/list,
 * the escalation probes, `config status`) — not just where this script itself
 * writes `settings.json` and the stable home.
 */
function museConfigDir(configDirOverride) {
  const xdg = configDirOverride ?? process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, 'muse') : join(homedir(), '.config', 'muse');
}

/** Env overrides so a spawned `muse` subprocess resolves the SAME config dir as this script. */
function museSubprocessEnv(configDirOverride) {
  return configDirOverride ? { XDG_CONFIG_HOME: configDirOverride } : {};
}

/**
 * Runs `muse` and returns a three-valued probe result.
 *
 * Status, signal and both streams are all preserved: an earlier version returned
 * only a string, so a crashed probe was indistinguishable from a clean "capability
 * present" answer and the preflight failed open.
 *
 * @param {string[]} args
 * @param {Record<string,string>} [env] extra env vars merged over process.env
 * @returns {{ status: number | null, signal: string | null, output: string, ran: boolean }}
 */
function probe(args, env = {}) {
  const result = spawnSync('muse', args, { encoding: 'utf8', env: { ...process.env, ...env } });
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
function escalationPreflight(env) {
  return escalationVerdict({
    profileProbe: probe(['exec', '--provider', 'echo', '--permission-profile', '__omm_probe__', 'x'], env),
    configProbe: probe(['config', 'status'], env),
  });
}

// --------------------------------------------------------------- marketplace

/**
 * Runs a `muse plugins ...` command against the isolated config dir and
 * returns `{ status, output }` for the plugin-route module.
 */
function runMuseForRoute(cmdArgs, env) {
  const result = probe(cmdArgs, env);
  return { status: result.status, output: result.output };
}

/**
 * True when this build's plugins subsystem is usable at all. On builds through
 * 1.1.1 every `muse plugins` command reported the subsystem as unavailable,
 * and a registered marketplace yielded no skills and no diagnostics. When
 * plugins are off, the manifest is inert and delivery has to go through
 * settings + a self-copied stable home instead. Muse 1.3.0-R3057.1 reports
 * `plugins: true` in its feature config and takes the marketplace route.
 */
function pluginsSupported(env) {
  const result = probe(['plugins', '--help'], env);
  if (!result.ran) return false;
  return !/plugins are not available in this build|missing plugins command/i.test(result.output);
}

function reportEscalationPosture(preflight) {
  console.log('External critic posture (read this before using --critic=codex):');
  if (preflight.namedProfiles === 'yes') {
    console.log('  Named permission profiles are available on this build; prefer scoping');
    console.log('  the escalation to a profile over --disable-sandbox.');
  } else {
    console.log('  No usable named permission profile was found, so the escalation');
    console.log('  CANNOT be scoped to the critic call. Running an external codex/claude');
    console.log('  critic requires launching the whole session with:');
    console.log('');
    console.log('      muse --disable-sandbox');
    console.log('');
    console.log("  That removes filesystem and network sandboxing for EVERYTHING in the");
    console.log("  session, not just the critic. It also puts the critic's work outside");
    console.log("  muse's append-only audit trail. Both are real costs of cross-model");
    console.log('  review; the in-harness critic persona keeps full containment instead.');
  }
}

// ---------------------------------------------------------------------- install

function runInstall(args) {
  const env = museSubprocessEnv(args.configDir);
  const preflight = escalationPreflight(env);
  const pluginsOn = pluginsSupported(env);

  if (preflight.blocked) {
    console.error(`${BIN_NAME}: refusing to install.\n`);
    for (const line of preflight.detail) console.error(`  - ${line}`);
    console.error('');

    if (preflight.blockReason === 'policy-forbids-bypass') {
      console.error('  Enterprise policy sets execution.forbid_sandbox_bypass.');
      console.error('  No usable named permission profile is available to scope an escalation, so');
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

  const configDir = museConfigDir(args.configDir);
  const settingsPath = join(configDir, 'settings.json');
  const version = pkgVersion();

  console.log(`${BIN_NAME} ${args.dryRun ? '(dry run)' : 'install'}`);
  console.log(`  plugin root: ${PLUGIN_ROOT}`);
  console.log(`  version:     ${version}`);
  console.log(`  workspace:   ${args.workspace}`);
  console.log(`  config dir:  ${configDir}`);
  console.log('');
  console.log('Escalation preflight:');
  for (const line of preflight.detail) console.log(`  - ${line}`);
  console.log('');

  if (pluginsOn) {
    // Primary route on builds with plugin support (Muse 1.3.0-R3057.1):
    // stage a pruned bundle, live-validate it, then
    // `plugins install <bundle> --scope user` + approve + enable.
    //
    // Supersession note: the earlier design wrote
    // `<workspace>/.agents/plugins/marketplace.json` by hand, but the live
    // binary does not honor that file — with it present
    // `plugins list --available` still reports `{"available":[]}`, and
    // `marketplace add` only registers a source that already contains a
    // catalog. The direct path install is the supported route, so the
    // hand-written file is gone; `plugins install` owns caching/durability
    // in muse's own store, the same way this installer owns them for the
    // settings route below.
    try {
      installPluginRoute({
        runMuse: (cmdArgs) => runMuseForRoute(cmdArgs, env),
        pluginRoot: PLUGIN_ROOT,
        pluginName: PLUGIN_NAME,
        dryRun: args.dryRun,
      });
    } catch (err) {
      fail(err.message);
    }
  } else {
    console.log('Delivery: muse settings (this build reports "plugins are not available").');
    console.log('  The plugin manifest is kept for builds that enable plugins, but it');
    console.log('  delivers nothing here, so skills, hooks and the MCP server are');
    console.log('  installed through routes verified to work on this build.');
    console.log('');

    const stableHome = resolveStableHome(configDir, version);

    // 1. Skills, via the documented installer. Independent of the stable
    //    home: `muse skills install` copies the skill directory itself.
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
      const result = probe(
        ['skills', 'install', join(PLUGIN_ROOT, 'skills', id), '--scope', 'user', '--force', '--json'],
        env,
      );
      if (!result.ran || result.status !== 0) {
        fail(`installing skill ${id} failed:\n${result.output}`);
      }
      console.log(`    installed ${id}`);
    }

    // 2. Stable home: hooks/dist/personas + the resolved dependency closure,
    //    copied out of the (possibly ephemeral) plugin root.
    console.log('');
    if (args.dryRun) {
      console.log(`  Would copy the runtime into ${stableHome}`);
    } else {
      installStableHome(PLUGIN_ROOT, configDir, version);
      console.log(`  Copied runtime into ${stableHome}`);
    }

    // 3. Hooks + MCP server, via settings.json, rooted at the stable home
    //    (not PLUGIN_ROOT) so they survive npx cache pruning.
    let current;
    try {
      current = readSettings(settingsPath);
    } catch (err) {
      fail(`${settingsPath} exists but is not valid JSON (${err.message}); refusing to overwrite it`);
    }

    // Migrate away from any OLDER version settings.json still references
    // before merging the new one in. Without this, upgrading versions left
    // the old version's hooks preserved as "foreign" (since ownership is
    // matched by exact stable-home path) and its omm-state mcp entry made
    // mergeSettings refuse outright as a naming conflict it doesn't
    // recognize as its own — confirmed by reproducing a 0.1.0 -> 0.2.0
    // upgrade during review.
    const homeParent = resolveHomeParent(configDir);
    const staleHomes = current
      ? referencedStableHomes(current, homeParent).filter((h) => h !== stableHome)
      : [];
    let migrated = current;
    for (const staleHome of staleHomes) migrated = unmergeSettings(migrated, staleHome);

    const merged = mergeSettings(migrated, stableHome);
    const mergedContents = JSON.stringify(merged, null, 2) + '\n';
    const currentContents = current ? readFileSync(settingsPath, 'utf8') : null;

    console.log('');
    if (staleHomes.length > 0) {
      console.log(
        `  ${args.dryRun ? 'Would migrate' : 'Migrating'} away from ${staleHomes.length} older install(s):`,
      );
      for (const staleHome of staleHomes) console.log(`    ${staleHome}`);
    }
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

    // Prune every other version directory now that settings.json points only
    // at the new one — otherwise every reinstall/upgrade leaves the previous
    // copy on disk forever.
    if (!args.dryRun) {
      for (const oldHome of installedStableHomes(homeParent)) {
        if (oldHome !== stableHome) rmSync(oldHome, { recursive: true, force: true });
      }
    }
  }

  console.log('');
  reportEscalationPosture(preflight);
  console.log('');
  console.log(`Next: trust the workspace, then run \`${BIN_NAME} doctor\` to verify.`);
}

// -------------------------------------------------------------------- uninstall

function runUninstall(args) {
  const env = museSubprocessEnv(args.configDir);
  const configDir = museConfigDir(args.configDir);
  const settingsPath = join(configDir, 'settings.json');
  const pluginsOn = pluginsSupported(env);

  console.log(`${BIN_NAME} uninstall`);
  console.log(`  config dir: ${configDir}`);
  console.log('');

  // The marketplace route owns its record in muse's plugin store, so it is
  // removed first; the settings cleanup below still runs (a machine upgraded
  // from a plugins-off build can have both), and both tolerate absence, so a
  // second uninstall exits clean.
  if (pluginsOn) {
    try {
      uninstallPluginRoute({
        runMuse: (cmdArgs) => runMuseForRoute(cmdArgs, env),
        pluginName: PLUGIN_NAME,
      });
    } catch (err) {
      fail(err.message);
    }
  }

  let current;
  try {
    current = readSettings(settingsPath);
  } catch (err) {
    fail(`${settingsPath} exists but is not valid JSON (${err.message}); refusing to touch it`);
  }

  if (current) {
    // Ownership is derived from what settings.json's hook/mcp paths actually
    // point at, not from which version directories still exist on disk — a
    // stable home the user (or a previous, interrupted uninstall) already
    // deleted by hand would otherwise leave its settings entries stuck
    // forever, since a directory listing finds nothing to unmerge against.
    const homeParent = resolveHomeParent(configDir);
    const homes = referencedStableHomes(current, homeParent);

    let next = current;
    for (const home of homes) {
      next = unmergeSettings(next, home);
    }
    const nextContents = JSON.stringify(next, null, 2) + '\n';
    const currentContents = readFileSync(settingsPath, 'utf8');

    if (nextContents !== currentContents) {
      writeSettings(settingsPath, next);
      console.log(`  Removed our hooks + mcp server from ${settingsPath}`);
    } else {
      console.log(`  ${settingsPath} had no entries of ours.`);
    }
  } else {
    console.log(`  ${settingsPath} does not exist; nothing to remove there.`);
  }

  removeAllStableHomes(configDir);
  console.log(`  Removed the installed runtime under ${join(configDir, 'oh-my-musecode')}`);

  if (args.purge) {
    console.log('');
    console.log('  --purge: removing installed skills');
    const skillIds = readdirSync(join(PLUGIN_ROOT, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const id of skillIds) {
      const result = probe(['skills', 'uninstall', id, '--json'], env);
      if (result.ran && result.status === 0) {
        console.log(`    removed ${id}`);
      } else {
        console.log(`    ${id}: not installed or already removed`);
      }
    }
  }

  console.log('');
  console.log('Uninstall complete.');
}

// ------------------------------------------------------------------------ doctor

async function runDoctorVerb(args) {
  // Dynamic import: doctor.mjs pulls in the MCP SDK client, which only
  // `doctor` needs (see the top-of-file note by the static imports).
  const { runDoctor, reportDoctor, probeMcpServer } = await import('./doctor.mjs');

  const env = museSubprocessEnv(args.configDir);
  const configDir = museConfigDir(args.configDir);
  const settingsPath = join(configDir, 'settings.json');

  console.log(`${BIN_NAME} doctor`);
  console.log(`  config dir: ${configDir}`);
  console.log('');

  // On builds with plugin support the settings route was never taken, so
  // its checks (stable home, settings entries, user-scope skills) would
  // report an install that is actually healthy as broken. Check the plugin
  // record, its capabilities, and the cached bundle instead.
  if (pluginsSupported(env)) {
    const expectedSkillIds = readdirSync(join(PLUGIN_ROOT, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const checks = await doctorPluginRoute({
      runMuse: (cmdArgs) => runMuseForRoute(cmdArgs, env),
      pluginName: PLUGIN_NAME,
      version: pkgVersion(),
      expectedSkillIds,
      workspace: args.workspace,
      probeMcp: probeMcpServer,
    });
    process.exit(reportDoctor({ ok: checks.every((c) => c.ok), checks }));
  }

  const result = await runDoctor({
    settingsPath,
    museConfigDir: configDir,
    workspace: args.workspace,
    probeSkills: async () => {
      const expectedIds = readdirSync(join(PLUGIN_ROOT, 'skills'), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      const listed = probe(['skills', 'list', '--source', 'user', '--json'], env);
      if (!listed.ran || listed.status !== 0) {
        return { name: 'skills visible', ok: false, detail: `muse skills list failed: ${listed.output}` };
      }
      let visibleIds;
      try {
        const parsed = JSON.parse(listed.output);
        visibleIds = new Set((parsed.skills ?? []).map((s) => s.id ?? s.name));
      } catch (err) {
        return { name: 'skills visible', ok: false, detail: `could not parse muse skills list --json: ${err.message}` };
      }
      const missing = expectedIds.filter((id) => !visibleIds.has(id));
      return {
        name: 'skills visible',
        ok: missing.length === 0,
        detail:
          missing.length === 0
            ? `${expectedIds.length}/${expectedIds.length} visible (scope: user)`
            : `missing: ${missing.join(', ')}`,
      };
    },
  });

  const manifest = result.resolvedHome ? readInstallManifest(result.resolvedHome) : null;
  if (manifest) {
    console.log(`  (installed version ${manifest.version}, installed ${manifest.installedAt})`);
    console.log('');
  }

  process.exit(reportDoctor(result));
}

// ---------------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));

// The manifest gate runs first: registering a plugin whose manifest declares a
// rejected capability would install something that loads but does not work.
if (args.verb === 'install') {
  try {
    execFileSync('node', [join(PLUGIN_ROOT, 'scripts', 'verify-manifest.mjs')], { stdio: 'pipe' });
  } catch (err) {
    fail(`manifest verification failed, refusing to install:\n${err.stdout?.toString() ?? err.message}`);
  }
}

switch (args.verb) {
  case 'install':
    runInstall(args);
    break;
  case 'uninstall':
    runUninstall(args);
    break;
  case 'doctor':
    await runDoctorVerb(args);
    break;
  default:
    fail(`unreachable: unknown verb "${args.verb}"`);
}
