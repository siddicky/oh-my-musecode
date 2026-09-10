/**
 * Stable runtime home for the installed harness.
 *
 * `scripts/install.mjs` runs from wherever npm/npx put the package. Under a
 * global install or a checkout that root is durable, but under `npx` it is
 * `~/.npm/_npx/<hash>/node_modules/@siddicky/oh-my-musecode` — a cache
 * directory npm/npx are free to prune. Baking that path into
 * `settings.json`'s hook `command` strings and the `omm-state` MCP server's
 * `args` would silently rot the install the next time the cache is cleaned.
 *
 * So install copies the runtime pieces (`hooks/`, `dist/`, `personas/`, and the
 * resolved production dependency closure) into a versioned, durable home under
 * the muse config directory, and `settings.json` points there instead of at
 * the invoking package root. `scripts/settings-install.mjs` is agnostic to
 * what "the plugin root" means — the stable home is simply passed as that
 * root — so it needs no changes to build on top of this.
 */

import { createRequire } from 'node:module';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { unshellQuote } from './settings-install.mjs';

/** Directory name holding every installed version, under the muse config dir. */
export const HOME_DIRNAME = 'oh-my-musecode';

/** Manifest filename recording what a stable home contains and where it came from. */
export const MANIFEST_FILENAME = '.install.json';

/** Top-level entries copied verbatim, preserving their relative layout. */
export const RUNTIME_ENTRIES = ['hooks', 'dist', 'personas'];

/** Parent directory holding every installed version, e.g. `<museConfigDir>/oh-my-musecode`. */
export function resolveHomeParent(museConfigDir) {
  return join(museConfigDir, HOME_DIRNAME);
}

/** Absolute path of the versioned stable home, e.g. `<museConfigDir>/oh-my-musecode/<version>`. */
export function resolveStableHome(museConfigDir, version) {
  return join(resolveHomeParent(museConfigDir), version);
}

/**
 * Every distinct stable-home path (under `homeParent`) that `settings` still
 * references, derived from the CONTENT of its hook commands and mcp args —
 * not from which version directories still exist on disk.
 *
 * This is what lets `install` clean up an older version's settings entries on
 * upgrade, and lets `uninstall` clean up entries left behind after a stable
 * home directory was already deleted by hand: both only work if ownership is
 * read from what settings.json actually points at, since a directory listing
 * tells you nothing once the directory is already gone.
 */
export function referencedStableHomes(settings, homeParent) {
  const configuredPaths = [];
  for (const groups of Object.values(settings?.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const hook of group?.hooks ?? []) {
        const path = unshellQuote(hook?.command);
        if (path) configuredPaths.push(path);
      }
    }
  }
  const mcpArgs = settings?.mcpServers?.['omm-state']?.args;
  if (Array.isArray(mcpArgs) && typeof mcpArgs[0] === 'string') configuredPaths.push(mcpArgs[0]);

  const homes = new Set();
  for (const path of configuredPaths) {
    const rel = relative(homeParent, path);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue; // not under homeParent at all
    const version = rel.split(sep)[0];
    if (version) homes.add(join(homeParent, version));
  }
  return [...homes];
}

/** Every version directory physically present under `homeParent`, regardless of what settings.json says. */
export function installedStableHomes(homeParent) {
  if (!existsSync(homeParent)) return [];
  return readdirSync(homeParent, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(homeParent, e.name));
}

/**
 * Locates a dependency's package directory and package.json on disk.
 *
 * This deliberately does NOT use `require.resolve(`${name}/package.json`)`.
 * A package whose `exports` map redirects the `./package.json` subpath (as
 * `@modelcontextprotocol/sdk` does, to a stub under `dist/cjs/` with no
 * `version` field) makes that resolve the wrong file with no error — silently
 * capturing an empty manifest instead of the real one. `require.resolve.paths`
 * instead gives the ordered list of `node_modules` directories Node would
 * search, and this reads `package.json` directly off disk in each in turn:
 * the real root, unaffected by any `exports` map.
 *
 * @param {string} fromDir directory whose own `node_modules` resolution applies
 * @param {string} name package name (scoped names like `@scope/pkg` supported)
 * @returns {{ dir: string, pkgJsonPath: string }}
 */
function resolvePackageDir(fromDir, name) {
  const require = createRequire(join(fromDir, 'package.json'));
  const candidates = require.resolve.paths(name) ?? [];
  for (const nodeModulesDir of candidates) {
    const dir = join(nodeModulesDir, ...name.split('/'));
    const pkgJsonPath = join(dir, 'package.json');
    if (existsSync(pkgJsonPath)) return { dir, pkgJsonPath };
  }
  throw new Error(`cannot resolve dependency "${name}" from ${fromDir}`);
}

/** Hard cap on nesting depth, guarding against a pathological or cyclic dependency graph. */
const MAX_NESTING_DEPTH = 40;

/**
 * Resolves the full production dependency closure of `pluginRoot`, mirroring
 * npm's own hoist/nest resolution rather than flattening to one global map.
 *
 * A real npm tree routinely resolves the same package name to two different
 * directories for two different importers — that is ordinary version
 * disambiguation (e.g. a transitive dep pins an older `content-type` than the
 * rest of the tree), not tree corruption. Silently picking one over the other
 * would be the actual bug: this instead hoists a name's resolution to the top
 * level and nests any later, differently-resolved occurrence of the same name
 * under its importer's own `node_modules` — exactly where Node's own
 * resolution algorithm would find it — so every distinct version is copied to
 * its own distinct location and none is silently dropped.
 *
 * The walk is breadth-first BY DEPTH, not depth-first: every one of the
 * plugin root's OWN direct dependencies claims the top-level hoist slot for
 * its name before any transitive dependency is even resolved. This matters —
 * a depth-first walk would let whichever branch happens to be listed first in
 * `dependencies` claim a name for its transitive requirement, potentially
 * pushing the ROOT's own direct requirement of that same name into a nested
 * path that Node's resolution algorithm can never actually reach (there is no
 * "the importer is the root itself" nesting target — the root's own
 * `node_modules` IS the top level). Node always resolves a root-level import
 * from the top-level `node_modules` first, so whatever sits there must
 * satisfy the root's own requirement; shallower requirements must win ties.
 *
 * @param {string} pluginRoot
 * @returns {{ destSegments: string[], srcDir: string, name: string, version: string }[]}
 */
export function resolveDependencyClosure(pluginRoot) {
  const rootPkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
  const hoisted = new Map(); // name -> srcDir chosen as the top-level copy
  const placed = new Set(); // `${srcDir}::${destSegments.join('/')}` already emitted
  const entries = [];

  let frontier = Object.keys(rootPkg.dependencies ?? {}).map((name) => ({
    name,
    fromDir: pluginRoot,
    importerDestSegments: [],
  }));

  while (frontier.length > 0) {
    const next = [];

    for (const { name, fromDir, importerDestSegments } of frontier) {
      const { dir, pkgJsonPath } = resolvePackageDir(fromDir, name);
      const nameSegments = name.split('/');

      let destSegments;
      const hoistedDir = hoisted.get(name);
      if (!hoistedDir) {
        hoisted.set(name, dir);
        destSegments = nameSegments;
      } else if (hoistedDir === dir) {
        continue; // already covered by the hoisted copy
      } else {
        destSegments = [...importerDestSegments, 'node_modules', ...nameSegments];
      }

      if (destSegments.length > MAX_NESTING_DEPTH) {
        throw new Error(
          `dependency "${name}" would nest ${destSegments.length} path segments deep ` +
            `(over the ${MAX_NESTING_DEPTH}-segment safety cap); this usually means a ` +
            `circular dependency chain is being mistaken for ever-deeper version conflicts`,
        );
      }

      const placedKey = `${dir}::${destSegments.join('/')}`;
      if (placed.has(placedKey)) continue;
      placed.add(placedKey);

      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      entries.push({ destSegments, srcDir: dir, name, version: pkg.version });

      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        next.push({ name: dep, fromDir: dir, importerDestSegments: destSegments });
      }
    }

    frontier = next;
  }

  return entries;
}

/** True when `absPath`, relative to `packageDir`, crosses a `node_modules` segment. */
function crossesNodeModules(packageDir, absPath) {
  if (absPath === packageDir) return false;
  const rel = absPath.slice(packageDir.length + 1);
  return rel.split(sep).includes('node_modules');
}

export class SymlinkedDestinationError extends Error {
  constructor(path) {
    super(
      `Refusing to write ${path}: it already exists as a symbolic link. Writing ` +
        `through it could place files somewhere other than the intended stable ` +
        `home, so a pre-planted symlink here is refused rather than followed.`,
    );
    this.name = 'SymlinkedDestinationError';
    this.path = path;
  }
}

/**
 * Refuses to write through a destination that already exists as a symlink.
 *
 * A stable home lives under the muse config directory, a NEW write surface
 * this installer introduces (`.omm/` already had this defense in
 * src/paths.ts for a different root; this is the equivalent for this one).
 * Anyone able to write there ahead of an install could otherwise plant a
 * symlink at a predictable path (the version directory, or one dependency's
 * install location) and have `cpSync` write through it.
 */
function assertNotSymlink(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return; // does not exist yet — nothing to guard
  }
  if (stats.isSymbolicLink()) throw new SymlinkedDestinationError(path);
}

/**
 * Copies a resolved dependency closure into `destNodeModules`, placing each
 * entry at its `destSegments` path (hoisted names at the top level, nested
 * overrides under their importer — see `resolveDependencyClosure`).
 *
 * Each package's own nested `node_modules` is excluded from the raw copy: any
 * dependency reachable from it is already represented as its own entry with
 * an explicit destination, so copying the nested folder too would only
 * duplicate bytes, not add correctness.
 */
export function copyDependencyClosure(entries, destNodeModules) {
  for (const { destSegments, srcDir } of entries) {
    const dest = join(destNodeModules, ...destSegments);
    assertNotSymlink(dest);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(srcDir, dest, {
      recursive: true,
      filter: (src) => !crossesNodeModules(srcDir, src),
    });
  }
}

/**
 * Installs a stable, versioned copy of the harness runtime.
 *
 * Copies `hooks/`, `dist/` and `personas/` (preserving their relative layout —
 * `dist/personas.js` resolves `../personas` from its own location) plus the
 * resolved production dependency closure, then writes a manifest recording
 * what was copied and from where.
 *
 * @param {string} pluginRoot the invoking package root (built: `dist/` must exist)
 * @param {string} museConfigDir e.g. `~/.config/muse`
 * @param {string} version
 * @returns {string} the stable home path
 */
export function installStableHome(pluginRoot, museConfigDir, version) {
  const home = resolveStableHome(museConfigDir, version);
  assertNotSymlink(home);
  mkdirSync(home, { recursive: true });

  const copiedEntries = [];
  for (const entry of RUNTIME_ENTRIES) {
    const src = join(pluginRoot, entry);
    if (!existsSync(src)) {
      throw new Error(
        `expected ${entry}/ at ${src}; build the package before installing (npm run build)`,
      );
    }
    const dest = join(home, entry);
    assertNotSymlink(dest);
    cpSync(src, dest, { recursive: true });
    copiedEntries.push(entry);
  }

  const nodeModulesDest = join(home, 'node_modules');
  assertNotSymlink(nodeModulesDest);
  const closure = resolveDependencyClosure(pluginRoot);
  copyDependencyClosure(closure, nodeModulesDest);

  writeInstallManifest(home, {
    version,
    sourceRoot: pluginRoot,
    installedAt: new Date().toISOString(),
    copiedEntries,
    dependencies: Object.fromEntries(
      closure.map(({ destSegments, version: v }) => [destSegments.join('/'), v]),
    ),
  });

  return home;
}

/** Writes a stable home's manifest. */
export function writeInstallManifest(home, manifest) {
  writeFileSync(join(home, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/** Reads a stable home's manifest, or `null` if absent or unparseable. */
export function readInstallManifest(home) {
  const path = join(home, MANIFEST_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Removes every installed version under the muse config dir. Safe to call
 * when nothing is installed.
 */
export function removeAllStableHomes(museConfigDir) {
  rmSync(resolveHomeParent(museConfigDir), { recursive: true, force: true });
}
