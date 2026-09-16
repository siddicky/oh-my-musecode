/**
 * Delivery through muse settings, for builds where the plugins subsystem is off.
 *
 * Historical note (builds through 1.1.1): those builds reported the plugins
 * subsystem as unavailable to every `muse plugins` command, and a registered
 * marketplace yielded `{"skills":[],"diagnostics":[]}` — no discovery and no
 * error. A plugin manifest alone therefore delivered nothing at all there.
 * On Muse 1.3.0-R3057.1 the plugins subsystem is on and the marketplace route
 * is primary (see scripts/install.mjs); this settings route remains as the
 * fallback for builds without plugin support.
 *
 * These routes were each verified to work instead:
 *   - skills: `muse skills install --scope user` installs into $CONFIG_DIR/skills/
 *   - hooks:  a `hooks` entry in $CONFIG_DIR/muse/settings.json genuinely fires
 *             (a SessionStart hook configured this way ran and created .omm/)
 *   - mcp:    an `mcpServers` entry in the same file is accepted
 *
 * The merge is deliberately conservative: it only touches keys it owns, so a
 * hand-maintained settings.json survives installation intact.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Identifies the entries this installer owns.
 *
 * Ownership is inferred from the command path rather than stamped with a marker
 * field. An earlier version added `__owner` to each hook entry; muse rejected the
 * unknown member and silently stopped loading the hook — no diagnostic, no error,
 * the hook simply never fired. Settings documents only tolerate the members muse
 * knows, so ownership has to be derived from what is already there.
 */
export const OWNER_TAG = 'oh-my-musecode';

/**
 * POSIX single-quote escaping for a path embedded in a shell command string.
 *
 * `JSON.stringify` is NOT shell quoting. Double quotes still permit command
 * substitution, so a plugin root containing `$(...)` or backticks would execute
 * when muse ran the hook — a checkout path is enough to get code execution.
 * Single quotes suppress all expansion; the only character needing care is the
 * single quote itself, closed and reopened around an escaped literal.
 */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * Reverses `shellQuote`: extracts the single-quoted path argument from a
 * `node '<path>'` command string. Returns `null` for anything that doesn't
 * match that exact shape (a hand-written or differently-quoted command is
 * left alone rather than misparsed).
 */
export function unshellQuote(command) {
  const match = /^node '((?:[^']|'\\''|'')*)'$/.exec(command ?? '');
  if (!match) return null;
  return match[1].replaceAll("'\\''", "'").replaceAll("''", "'");
}

/** True when a hook command points at a script inside this plugin. */
function commandBelongsTo(command, pluginRoot) {
  return typeof command === 'string' && command.includes(join(pluginRoot, 'hooks'));
}

/** Builds the hook entries, rooted at an absolute plugin directory. */
export function desiredHooks(pluginRoot) {
  const hook = (script) => ({
    type: 'command',
    command: `node ${shellQuote(join(pluginRoot, 'hooks', script))}`,
  });

  return {
    UserPromptSubmit: [{ hooks: [hook('user-prompt-submit.mjs')] }],
    SessionStart: [{ hooks: [hook('session-start.mjs')] }],
    Stop: [{ hooks: [hook('stop.mjs')] }],
  };
}

/** Builds the MCP server entry. */
export function desiredMcpServers(pluginRoot) {
  return {
    'omm-state': {
      transport: 'stdio',
      command: 'node',
      args: [join(pluginRoot, 'dist', 'mcp', 'state-server.js')],
    },
  };
}

/** True when a settings hook group belongs to us. */
function isOurs(group, pluginRoot) {
  return (group?.hooks ?? []).some((h) => commandBelongsTo(h?.command, pluginRoot));
}

/**
 * Merges our hooks and MCP server into an existing settings document without
 * disturbing anything else.
 *
 * Idempotent by construction: our own previous entries are dropped before the
 * current ones are appended, so repeated installs converge rather than stacking
 * duplicate hooks.
 */
export function mergeSettings(existing, pluginRoot) {
  const next = existing && typeof existing === 'object' ? structuredClone(existing) : {};
  if (typeof next.schema_version !== 'number') next.schema_version = 1;

  const hooks = { ...(next.hooks ?? {}) };
  for (const [event, groups] of Object.entries(desiredHooks(pluginRoot))) {
    const foreign = (hooks[event] ?? []).filter((group) => !isOurs(group, pluginRoot));
    hooks[event] = [...foreign, ...groups];
  }
  next.hooks = hooks;

  const servers = { ...(next.mcpServers ?? {}) };
  for (const [id, server] of Object.entries(desiredMcpServers(pluginRoot))) {
    const existingServer = servers[id];
    // Merge and unmerge must agree on ownership. Unmerge only removes an
    // omm-state entry pointing into this plugin, so merge must not silently
    // replace one that does not — that would destroy an unrelated server that
    // merely shares the id, and leave it unrecoverable.
    if (existingServer && !(existingServer.args ?? []).join(' ').includes(pluginRoot)) {
      throw new Error(
        `settings already define an mcpServer named "${id}" that is not ours ` +
          `(${JSON.stringify(existingServer.command ?? '')}). Refusing to overwrite it; ` +
          `rename or remove it first.`,
      );
    }
    servers[id] = server;
  }
  next.mcpServers = servers;

  return next;
}

/** Removes every entry this installer owns. */
export function unmergeSettings(existing, pluginRoot) {
  const next = structuredClone(existing ?? {});

  if (next.hooks) {
    for (const event of Object.keys(next.hooks)) {
      const remaining = (next.hooks[event] ?? []).filter((group) => !isOurs(group, pluginRoot));
      if (remaining.length > 0) next.hooks[event] = remaining;
      else delete next.hooks[event];
    }
    if (Object.keys(next.hooks).length === 0) delete next.hooks;
  }

  if (next.mcpServers) {
    for (const [id, server] of Object.entries(next.mcpServers)) {
      const arg = (server?.args ?? []).join(' ');
      if (id === 'omm-state' && arg.includes(pluginRoot)) delete next.mcpServers[id];
    }
    if (Object.keys(next.mcpServers).length === 0) delete next.mcpServers;
  }

  return next;
}

/** Reads a settings document, or null when absent. Throws on malformed JSON. */
export function readSettings(settingsPath) {
  if (!existsSync(settingsPath)) return null;
  return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

/** Writes a settings document, creating the config directory if needed. */
export function writeSettings(settingsPath, document) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(document, null, 2) + '\n', 'utf8');
}
