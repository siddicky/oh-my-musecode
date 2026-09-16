/**
 * Plugin-bundle staging for the marketplace install route.
 *
 * `muse plugins install <path>` installs a plugin bundle: a directory holding
 * the `.muse-plugin/` manifest plus every file the manifest references, with
 * NO symlinks anywhere in the tree (the live validator reports "plugin
 * contains symlink entries and cannot be installed" otherwise) and a bounded
 * inventory (a full `node_modules` tree makes Agent Definition inventory
 * derivation fail closed — see US-002 probe notes).
 *
 * So the bundle is NOT the raw repo root: it is the stable-home runtime
 * (`hooks/`, `dist/`, `personas/`, pruned production dependency closure —
 * reused from stable-home.mjs) plus the plugin surface (`skills/`,
 * `.muse-plugin/`, `package.json`). The production closure copies contain no
 * symlinks (npm plants `.bin` shims at the top level, outside any package
 * dir), but staging still sweeps for symlinks and fails closed naming the
 * offender, so a future dependency that ships one cannot silently produce an
 * uninstallable bundle.
 *
 * The bundle is staged under the OS temp dir because `plugins install` copies
 * the package into muse's own cache — the source needs no durability, and a
 * temp staging keeps versioned state (stable homes, settings.json) owned by
 * exactly one route each.
 */

import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, sep } from 'node:path';

import { copyDependencyClosure, resolveDependencyClosure } from './stable-home.mjs';

/** Manifest filename recording what a staged bundle contains and where it came from. */
export const BUNDLE_MANIFEST_FILENAME = '.bundle.json';

/** Top-level entries staged verbatim: the plugin surface plus the runtime. */
export const BUNDLE_ENTRIES = ['.muse-plugin', 'skills', 'hooks', 'dist', 'personas', 'package.json'];

/** Error thrown when staging finds a symlink that would make the bundle uninstallable. */
export class BundleSymlinkError extends Error {
  constructor(path) {
    super(
      `Refusing to stage plugin bundle: ${path} is a symbolic link. ` +
        '`muse plugins install` rejects bundles containing symlink entries, so staging ' +
        'fails here with the path rather than letting the install fail downstream.',
    );
    this.name = 'BundleSymlinkError';
    this.path = path;
  }
}

/**
 * File extensions never loaded by plain `node` at runtime: sources, maps,
 * and docs shipped inside dependency packages. Pruned from the staged
 * `node_modules` so the bundle stays under the plugin inventory's file
 * budget (a full tree makes Agent Definition inventory derivation fail
 * closed). `.d.ts` goes with the rest — node resolves `.js`/`.cjs`/`.mjs`
 * only, never types.
 */
const PRUNED_EXTENSIONS = new Set(['.md', '.markdown', '.map', '.ts', '.mts', '.cts']);

/** Directory names that never contribute to runtime resolution. */
const PRUNED_DIRNAMES = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'docs',
  'doc',
  'examples',
  'example',
  'benchmarks',
  'benchmark',
  'coverage',
]);

/**
 * True when a staged dependency file can be deleted without affecting
 * runtime resolution: non-loadable extensions, non-code directories, and
 * dotfiles (lint/CI configs — never `require`d). `package.json` and
 * `LICENSE*` are always kept.
 */
function isPrunableNodeModuleFile(absPath, nodeModulesRoot) {
  const base = basename(absPath);
  if (base === 'package.json' || base.startsWith('LICENSE')) return false;
  if (base.startsWith('.')) return true;
  const dot = base.lastIndexOf('.');
  if (dot >= 0 && PRUNED_EXTENSIONS.has(base.slice(dot).toLowerCase())) return true;
  const rel = absPath.slice(nodeModulesRoot.length + 1);
  if (rel.split(sep).some((segment) => PRUNED_DIRNAMES.has(segment))) return true;
  return false;
}

/**
 * Stages an installable plugin bundle from `pluginRoot` into `stagingDir`.
 *
 * @param {string} pluginRoot the invoking package root (built: `dist/` must exist)
 * @param {string} stagingDir empty (or absent) directory to stage into
 * @returns {{ bundleDir: string, version: string, prunedFiles: number }} the bundle dir, version, prune count
 */
export function stagePluginBundle(pluginRoot, stagingDir) {
  for (const entry of BUNDLE_ENTRIES) {
    const src = join(pluginRoot, entry);
    if (!lstatSync(src, { throwIfNoEntry: false })) {
      throw new Error(
        `expected ${entry} at ${src}; build the package before installing (npm run build)`,
      );
    }
  }

  const version = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')).version;

  mkdirSync(stagingDir, { recursive: true });
  for (const entry of BUNDLE_ENTRIES) {
    cpSync(join(pluginRoot, entry), join(stagingDir, entry), { recursive: true });
  }

  const closure = resolveDependencyClosure(pluginRoot);
  const nodeModulesRoot = join(stagingDir, 'node_modules');
  copyDependencyClosure(closure, nodeModulesRoot);

  // Fail closed on symlinks first: `plugins install` rejects any bundle
  // containing them, so name the offender here instead of shipping an
  // uninstallable tree. Then prune non-runtime files (see PRUNED_* above).
  const offenders = [];
  const collectSymlinks = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isSymbolicLink()) offenders.push(abs);
      else if (entry.isDirectory()) collectSymlinks(abs);
    }
  };
  collectSymlinks(stagingDir);
  if (offenders.length > 0) throw new BundleSymlinkError(offenders[0]);

  let prunedFiles = 0;
  const pruneTree = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        const rel = abs.slice(stagingDir.length + 1);
        const insideNodeModules = rel === 'node_modules' || rel.startsWith(`node_modules${sep}`);
        const prunableDir =
          insideNodeModules &&
          rel
            .slice(`node_modules${sep}`.length)
            .split(sep)
            .some((segment) => PRUNED_DIRNAMES.has(segment));
        if (prunableDir) {
          rmSync(abs, { recursive: true, force: true });
          prunedFiles++;
        } else {
          pruneTree(abs);
        }
      } else if (!entry.isSymbolicLink()) {
        const rel = abs.slice(stagingDir.length + 1);
        const insideNodeModules = rel.startsWith(`node_modules${sep}`);
        if (insideNodeModules && isPrunableNodeModuleFile(abs, nodeModulesRoot)) {
          rmSync(abs, { force: true });
          prunedFiles++;
        }
      }
    }
  };
  pruneTree(stagingDir);

  writeFileSync(
    join(stagingDir, BUNDLE_MANIFEST_FILENAME),
    JSON.stringify(
      { version, sourceRoot: pluginRoot, stagedAt: new Date().toISOString(), prunedFiles },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  return { bundleDir: stagingDir, version, prunedFiles };
}
