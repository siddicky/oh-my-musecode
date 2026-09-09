/**
 * State-root resolution and protected-path enforcement.
 *
 * muse protects `.agents/` and `.muse/` with two independent layers: a mediated
 * `edit_file` write is held for human review with no standing grant, and a shell
 * write fails read-only at the sandbox. Runtime state therefore cannot live in
 * either, so oh-my-musecode keeps its own root at `.omm/`.
 *
 * This module is the single place that decides whether a path is writable, so the
 * hooks and the MCP state server cannot drift apart on it.
 */

import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Directory name of the oh-my-musecode state root, relative to the workspace. */
export const STATE_ROOT_DIRNAME = '.omm';

/**
 * Path prefixes muse protects. A write that resolves inside any of these is
 * refused before it reaches the filesystem, so the failure is a clear error
 * rather than an opaque read-only sandbox rejection mid-run.
 */
export const PROTECTED_DIRNAMES = Object.freeze(['.agents', '.muse', '.git']);

export class ProtectedPathError extends Error {
  readonly path: string;
  readonly protectedSegment: string;

  constructor(path: string, protectedSegment: string) {
    super(
      `Refusing to write ${path}: \`${protectedSegment}/\` is a muse-protected path. ` +
        `State belongs under ${STATE_ROOT_DIRNAME}/.`,
    );
    this.name = 'ProtectedPathError';
    this.path = path;
    this.protectedSegment = protectedSegment;
  }
}

export class EscapedStateRootError extends Error {
  readonly path: string;

  constructor(path: string, stateRoot: string) {
    super(`Refusing to write ${path}: resolved outside the state root ${stateRoot}.`);
    this.name = 'EscapedStateRootError';
    this.path = path;
  }
}

/** Absolute path of the state root for a workspace. */
export function stateRoot(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), STATE_ROOT_DIRNAME);
}

/**
 * Creates the state root if absent. Returns its absolute path.
 *
 * Called by the SessionStart hook. Deliberately does not touch `.agents/` or
 * `.muse/`, which the harness owns.
 */
export function ensureStateRoot(workspaceRoot: string): string {
  const root = stateRoot(workspaceRoot);
  if (!existsSync(root)) {
    mkdirSync(join(root, 'state'), { recursive: true });
  }
  return root;
}

/** True when `candidate` is inside `parent` (or is `parent` itself). */
function isInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  // `rel.startsWith('..')` alone would also reject a legitimate in-root name like
  // `..notes`, so require the `..` to be a whole segment.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export class SymlinkedStateRootError extends Error {
  readonly path: string;

  constructor(root: string) {
    super(
      `Refusing to use ${root}: the state root itself is a symbolic link. ` +
        `Resolving it would relocate every state operation to its target, which is ` +
        `exactly the escape the traversal check exists to prevent.`,
    );
    this.name = 'SymlinkedStateRootError';
    this.path = root;
  }
}

export class SymlinkTraversalError extends Error {
  readonly path: string;

  constructor(path: string, linkPath: string) {
    super(
      `Refusing to write ${path}: the path crosses a symbolic link (${linkPath}). ` +
        `Symlinks can point outside the state root, so they are not followed.`,
    );
    this.name = 'SymlinkTraversalError';
    this.path = path;
  }
}

/**
 * Refuses any path that traverses a symbolic link between the state root and the
 * target.
 *
 * Lexical containment is not sufficient on its own: `.omm/link -> /etc` passes
 * every string check while resolving outside the root. Walking the existing
 * prefix and rejecting symlinks closes that escape for both the final component
 * and every intermediate directory.
 *
 * A residual TOCTOU window remains — the path is checked, then opened — because
 * Node exposes no `openat`-style confined traversal. Narrowing it further would
 * need a native binding; callers should not treat this as a boundary against a
 * local attacker who can create symlinks inside `.omm/` concurrently.
 */
function assertNoSymlinkTraversal(root: string, resolved: string): void {
  const rel = relative(root, resolved);
  if (rel === '') return;

  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    let stats;
    try {
      stats = lstatSync(current);
    } catch {
      // Does not exist yet: nothing below it can be a link either.
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new SymlinkTraversalError(resolved, current);
    }
  }
}

/**
 * Resolves a caller-supplied path against the state root and refuses anything
 * that escapes it or lands in a muse-protected directory.
 *
 * Both checks are needed and neither subsumes the other: the protected-path check
 * gives an accurate message for the common mistake (`../../.agents/AGENTS.md`),
 * while the containment check is the actual security boundary and catches every
 * other escape.
 *
 * @throws {ProtectedPathError} when the path resolves into `.agents/`, `.muse/` or `.git/`
 * @throws {EscapedStateRootError} when the path resolves outside the state root
 */
export function resolveWritablePath(workspaceRoot: string, requestedPath: string): string {
  const workspace = resolve(workspaceRoot);
  const root = stateRoot(workspace);
  const resolved = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(root, requestedPath);

  // Report a protected hit specifically, even when the path also escaped the
  // state root — `../../.agents/AGENTS.md` is a more useful error than "escaped".
  const segments = relative(workspace, resolved).split(sep);
  for (const protectedName of PROTECTED_DIRNAMES) {
    if (segments.includes(protectedName)) {
      throw new ProtectedPathError(requestedPath, protectedName);
    }
  }

  if (!isInside(root, resolved)) {
    throw new EscapedStateRootError(requestedPath, root);
  }

  // Lexical containment passed; now make sure the path does not reach outside the
  // root through a link.
  //
  // The root itself is checked FIRST and separately. Resolving it with realpath
  // before checking would silently relocate every subsequent operation: with
  // `.omm -> /somewhere/else`, the traversal walk starts inside the target and
  // finds nothing wrong, handing out a complete external read/write/delete
  // primitive. The root link must be refused, not followed.
  if (existsSync(root)) {
    if (lstatSync(root).isSymbolicLink()) {
      throw new SymlinkedStateRootError(root);
    }
    // Safe now that the root is known to be a real directory: realpath only
    // normalises symlinked ancestors of the workspace (on macOS /tmp is a link
    // to /private/tmp), so containment comparisons still line up.
    const realRoot = realpathSync(root);
    assertNoSymlinkTraversal(realRoot, resolve(realRoot, relative(root, resolved)));
  }

  return resolved;
}
