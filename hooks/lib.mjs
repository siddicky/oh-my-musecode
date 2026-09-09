/**
 * Shared hook plumbing.
 *
 * Hooks run before anything has been built, so this file and its callers stay
 * plain ESM with no dependency on dist/ and no third-party imports.
 */

/**
 * Reads and parses the JSON payload muse writes to a hook's stdin.
 *
 * A hook that throws is a hook that breaks the user's session, so a missing or
 * malformed payload resolves to an empty object and lets the caller no-op.
 *
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readPayload() {
  if (process.stdin.isTTY) return {};

  const chunks = [];
  try {
    for await (const chunk of process.stdin) chunks.push(chunk);
  } catch {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Resolves the workspace root from the hook payload, falling back to cwd.
 *
 * @param {Record<string, any>} payload
 * @returns {string}
 */
export function workspaceRootFrom(payload) {
  return (
    payload.workspace_root ??
    payload.workspaceRoot ??
    payload.cwd ??
    process.env.MUSE_WORKSPACE_ROOT ??
    process.cwd()
  );
}

/**
 * Emits additional context for the current turn and exits 0.
 *
 * @param {string | null} context
 * @returns {never}
 */
export function emitContext(context) {
  if (context) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { additionalContext: context } }) + '\n',
    );
  }
  process.exit(0);
}
