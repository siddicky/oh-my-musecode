/**
 * The .omm/ state store.
 *
 * Every path that reaches the filesystem goes through `resolveWritablePath`, which
 * refuses anything landing in a muse-protected directory or escaping the state
 * root. Keeping that policy in one module means the MCP tool surface cannot
 * accidentally grow a path that skips the check.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ensureStateRoot, resolveWritablePath, stateRoot } from './paths.js';

export interface StateStoreOptions {
  /** Workspace root the store is anchored to. */
  workspaceRoot: string;
}

export class StateStore {
  readonly workspaceRoot: string;

  constructor({ workspaceRoot }: StateStoreOptions) {
    this.workspaceRoot = workspaceRoot;
  }

  /** Absolute path of this store's state root. */
  get root(): string {
    return stateRoot(this.workspaceRoot);
  }

  /**
   * Reads a state file. Returns null when absent, so callers can distinguish
   * "nothing stored yet" from an error without a try/catch.
   *
   * @throws {ProtectedPathError | EscapedStateRootError} when the path is not readable-in-scope
   */
  read(relativePath: string): string | null {
    const resolved = resolveWritablePath(this.workspaceRoot, relativePath);
    if (!existsSync(resolved)) return null;
    return readFileSync(resolved, 'utf8');
  }

  /**
   * Writes a state file, creating parent directories inside the state root.
   *
   * @throws {ProtectedPathError | EscapedStateRootError} when the path is out of scope
   */
  write(relativePath: string, contents: string): string {
    const resolved = resolveWritablePath(this.workspaceRoot, relativePath);
    ensureStateRoot(this.workspaceRoot);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, contents, 'utf8');
    return resolved;
  }

  /**
   * Removes a state file or directory. Absent targets are a no-op so callers can
   * clear unconditionally.
   *
   * @throws {ProtectedPathError | EscapedStateRootError} when the path is out of scope
   */
  clear(relativePath: string): boolean {
    const resolved = resolveWritablePath(this.workspaceRoot, relativePath);
    if (!existsSync(resolved)) return false;
    rmSync(resolved, { recursive: true, force: true });
    return true;
  }
}
