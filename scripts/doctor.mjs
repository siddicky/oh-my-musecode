/**
 * `oh-my-musecode doctor`: verifies an installed harness actually works.
 *
 * Every check reads the SAME settings.json an install wrote, so doctor tells
 * the truth about what would actually fire in a real muse session rather than
 * re-deriving an expected path independently and comparing against that.
 *
 * Critically, "resolves on disk" is NOT enough to call a hook or the mcp
 * server healthy: a stale reinstall, a hand-edited settings.json, or a
 * compromised one could point at some OTHER existing file that merely
 * happens to sit under a path containing "hooks/", or at the source
 * checkout's own dist/ instead of the installed copy — and doctor would
 * wrongly call that healthy. So every configured path is required to fall
 * inside ONE stable home that this installer actually created (verified by
 * its `.install.json` manifest), not just to exist. `mcp server spawns`
 * refuses to even run the configured command when its path fails that check.
 */

import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { readSettings, unshellQuote } from './settings-install.mjs';
import { readInstallManifest, resolveHomeParent } from './stable-home.mjs';

const HOOK_EVENTS = ['SessionStart', 'Stop', 'UserPromptSubmit'];

/** One doctor check result. */
function check(name, ok, detail) {
  return { name, ok, detail };
}

/** True when `candidate` is `parent` or lies inside it. */
function isInsideDir(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Every subdirectory of `homeParent` that carries a readable `.install.json`
 * — i.e. a stable home this installer actually created, not just any
 * directory that happens to exist there.
 */
function listVerifiedStableHomes(homeParent) {
  if (!existsSync(homeParent)) return [];
  return readdirSync(homeParent, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(homeParent, e.name))
    .filter((dir) => readInstallManifest(dir) !== null);
}

/**
 * Runs every doctor check against the settings document at `settingsPath`.
 *
 * @param {{ settingsPath: string, museConfigDir: string, workspace: string, probeSkills?: () => Promise<ReturnType<typeof check>> }} opts
 * @returns {Promise<{ ok: boolean, checks: ReturnType<typeof check>[], resolvedHome: string | null }>}
 */
export async function runDoctor({ settingsPath, museConfigDir, workspace, probeSkills }) {
  const checks = [];

  let settings;
  try {
    settings = readSettings(settingsPath);
  } catch (err) {
    checks.push(check('settings.json', false, `not valid JSON: ${err.message}`));
    return { ok: false, checks, resolvedHome: null };
  }

  if (!settings) {
    checks.push(check('settings.json', false, `not found at ${settingsPath}`));
    return { ok: false, checks, resolvedHome: null };
  }
  checks.push(check('settings.json', true, settingsPath));

  // ---- raw paths configured in settings.json, unquoted but not yet trusted ----
  const rawHookPaths = {};
  for (const event of HOOK_EVENTS) {
    const groups = settings.hooks?.[event] ?? [];
    const commands = groups.flatMap((g) => g.hooks ?? []).map((h) => h.command);
    const path = commands.map(unshellQuote).find((p) => p !== null) ?? null;
    rawHookPaths[event] = path;
  }

  const missingEvents = HOOK_EVENTS.filter((e) => !rawHookPaths[e]);
  if (missingEvents.length > 0) {
    checks.push(
      check('hooks registered', false, `settings.json is missing our hook for: ${missingEvents.join(', ')}`),
    );
  } else {
    checks.push(check('hooks registered', true, `${HOOK_EVENTS.length}/${HOOK_EVENTS.length} events`));
  }

  const server = settings.mcpServers?.['omm-state'];
  const mcpEntryPath = Array.isArray(server?.args) ? server.args[0] : null;

  // ---- canonical root: the ONE verified stable home that contains every ----
  // ---- configured path, hooks and mcp entry alike ---------------------------
  const homeParent = resolveHomeParent(museConfigDir);
  const candidateHomes = listVerifiedStableHomes(homeParent);
  const configuredPaths = [...Object.values(rawHookPaths), mcpEntryPath].filter((p) => p !== null);
  const resolvedHome =
    configuredPaths.length > 0
      ? (candidateHomes.find((home) => configuredPaths.every((p) => isInsideDir(home, p))) ?? null)
      : null;
  const noVerifiedHomeReason =
    candidateHomes.length === 0
      ? `no verified install found under ${homeParent}`
      : 'configured paths do not all fall inside any single verified install';

  // ---- hook files resolve: on disk AND inside the resolved stable home ----
  let resolvedCount = 0;
  const unresolved = [];
  for (const [event, path] of Object.entries(rawHookPaths)) {
    if (!path) continue;
    if (!resolvedHome) {
      unresolved.push(`${event} -> ${path} (${noVerifiedHomeReason})`);
    } else if (!isInsideDir(resolvedHome, path)) {
      unresolved.push(`${event} -> ${path} (outside the installed stable home)`);
    } else if (!existsSync(path)) {
      unresolved.push(`${event} -> ${path} (missing on disk)`);
    } else {
      resolvedCount++;
    }
  }
  checks.push(
    check(
      'hook files resolve',
      resolvedCount === HOOK_EVENTS.length,
      resolvedCount === HOOK_EVENTS.length
        ? `${resolvedCount}/${HOOK_EVENTS.length} resolve inside a verified install`
        : `stale, missing, or unverified: ${unresolved.join('; ') || 'no hooks configured'}`,
    ),
  );

  // ---- mcp server -------------------------------------------------------
  if (!mcpEntryPath) {
    checks.push(check('mcp server registered', false, 'no omm-state entry in settings.json'));
    checks.push(check('mcp server spawns', false, 'skipped: not registered'));
  } else {
    checks.push(check('mcp server registered', true, mcpEntryPath));

    // Containment on `args[0]` alone is not enough: `command` (the actual
    // program spawned, with args[0] passed to IT as an argument) is just as
    // attacker-controllable, and a legitimate-looking, verified entry-point
    // path proves nothing if `command` itself has been swapped for something
    // else — that something else is what actually runs. This installer only
    // ever writes `command: 'node'` (see desiredMcpServers in
    // settings-install.mjs), so anything else is refused outright rather
    // than spawned to find out what it does.
    const command = server.command ?? 'node';
    if (command !== 'node') {
      checks.push(
        check(
          'mcp server spawns',
          false,
          `refusing to spawn: configured command is "${command}", not the "node" this installer always writes`,
        ),
      );
    } else if (!resolvedHome || !isInsideDir(resolvedHome, mcpEntryPath)) {
      // Refuse to even spawn a command settings.json points at outside a
      // verified install — that would run whatever is configured there
      // (arbitrary, if settings.json were compromised or simply stale)
      // under the guise of "the installed server is healthy".
      checks.push(
        check(
          'mcp server spawns',
          false,
          `refusing to spawn: ${mcpEntryPath} is not inside a verified install (${resolvedHome ? 'outside ' + resolvedHome : noVerifiedHomeReason})`,
        ),
      );
    } else if (!existsSync(mcpEntryPath)) {
      checks.push(check('mcp server spawns', false, `entry point does not exist: ${mcpEntryPath}`));
    } else {
      checks.push(await probeMcpServer(command, mcpEntryPath, workspace));
    }
  }

  // ---- skills -------------------------------------------------------
  if (probeSkills) {
    checks.push(await probeSkills());
  }

  const ok = checks.every((c) => c.ok);
  return { ok, checks, resolvedHome };
}

/**
 * Actually connects to the mcp server over stdio and lists its tools — proof
 * it starts, speaks MCP, and exposes something, not just that the process
 * doesn't immediately crash.
 */
async function probeMcpServer(command, entryPath, workspace) {
  const transport = new StdioClientTransport({
    command,
    args: [entryPath],
    env: { ...process.env, MUSE_WORKSPACE_ROOT: workspace },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'oh-my-musecode-doctor', version: '0.0.0' }, { capabilities: {} });

  const timeoutMs = 5000;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)),
    ]);
    const tools = await client.listTools();
    await client.close();
    return check('mcp server spawns', true, `responded, ${tools.tools?.length ?? 0} tools`);
  } catch (err) {
    try {
      await client.close();
    } catch {
      // already dead
    }
    return check('mcp server spawns', false, err.message);
  }
}

/** Renders doctor results as the CLI's printed report. Returns the exit code. */
export function reportDoctor({ ok, checks }) {
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(22)} ${c.detail}`);
  }
  console.log('');
  console.log(ok ? 'doctor: healthy' : 'doctor: unhealthy');
  return ok ? 0 : 1;
}
