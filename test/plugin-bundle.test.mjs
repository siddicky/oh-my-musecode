/**
 * Plugin-bundle staging tests.
 *
 * Staging must produce a self-contained, symlink-free tree with everything
 * the manifest references, and must fail closed (naming the offender) when a
 * dependency ships a symlink — because `muse plugins install` rejects such
 * bundles downstream.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BUNDLE_ENTRIES, stagePluginBundle } from '../scripts/plugin-bundle.mjs';
import { ROOT } from './helpers/install-sandbox.mjs';

test('staging copies every bundle entry and records provenance', () => {
  const staging = mkdtempSync(join(tmpdir(), 'omm-bundle-test-'));
  try {
    const result = stagePluginBundle(ROOT, staging);
    assert.equal(result.bundleDir, staging);
    assert.equal(result.version, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
    for (const entry of BUNDLE_ENTRIES) {
      assert.ok(existsSync(join(staging, entry)), `${entry} must be staged`);
    }
    assert.ok(existsSync(join(staging, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json')));
    const manifest = JSON.parse(readFileSync(join(staging, '.bundle.json'), 'utf8'));
    assert.equal(manifest.version, result.version);
    assert.equal(manifest.sourceRoot, ROOT);
    assert.ok(manifest.prunedFiles > 0, 'the production closure must shrink in staging');
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('staging refuses to build without dist (unbuilt package)', () => {
  const staging = mkdtempSync(join(tmpdir(), 'omm-bundle-test-'));
  try {
    assert.throws(
      () => stagePluginBundle(join(ROOT, 'scripts'), staging),
      /expected .muse-plugin/,
      'must name the missing entry, not fail later at install time',
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('staging fails closed naming a symlinked dependency file', () => {
  const root = mkdtempSync(join(tmpdir(), 'omm-bundle-fixture-'));
  const staging = mkdtempSync(join(tmpdir(), 'omm-bundle-test-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '9.9.9', dependencies: { leftpad: '^1.0.0' } }));
    for (const entry of ['.muse-plugin', 'skills', 'hooks', 'dist', 'personas']) {
      mkdirSync(join(root, entry), { recursive: true });
    }
    const dep = join(root, 'node_modules', 'leftpad');
    mkdirSync(dep, { recursive: true });
    writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'leftpad', version: '1.0.0' }));
    writeFileSync(join(dep, 'index.js'), 'module.exports = 1;\n');
    symlinkSync(join(dep, 'index.js'), join(dep, 'aliased.js'));

    assert.throws(
      () => stagePluginBundle(root, staging),
      (err) => err.name === 'BundleSymlinkError' && err.message.includes('aliased.js'),
      'must throw BundleSymlinkError naming the symlink',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
});
