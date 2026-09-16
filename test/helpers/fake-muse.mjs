#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
const configRoot = join(process.env.XDG_CONFIG_HOME, 'muse');
const skillsRoot = join(configRoot, 'skills');
const matches = (...expected) =>
  args.length === expected.length && expected.every((value, index) => value === null || value === args[index]);

/**
 * Plugins-on mode (`OMM_FAKE_PLUGINS=on`): mirrors the live Muse 1.3.0
 * `plugins` surface the installer exercises — install/approve/enable,
 * list/inspect, remove, validate — backed by a JSON store plus a call log,
 * both under the isolated XDG_CONFIG_HOME. Default (env unset) preserves the
 * historical plugins-off behavior byte-for-byte for the settings-route tests.
 */
const pluginsOn = process.env.OMM_FAKE_PLUGINS === 'on';
const storePath = join(configRoot, 'fake-plugin-store.json');
const callsPath = join(configRoot, 'fake-calls.log');

function logCall() {
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(callsPath, args.join(' ') + '\n', { flag: 'a' });
}

function readStore() {
  try {
    return JSON.parse(readFileSync(storePath, 'utf8'));
  } catch {
    return { plugins: {} };
  }
}

function writeStore(store) {
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(storePath, JSON.stringify(store, null, 2));
}

function failJson(code, message) {
  console.log(JSON.stringify({ error: { code, message } }));
  console.log(message);
  process.exitCode = 1;
}

/** Symlink entries make a bundle uninstallable on the live CLI; the fake enforces the same gate. */
function findSymlink(root) {
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      if (entry.isSymbolicLink()) return abs;
      if (entry.isDirectory()) {
        const hit = walk(abs);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(root);
}

function readBundleManifest(bundlePath) {
  const manifestPath = join(bundlePath, '.muse-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) return null;
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

if (pluginsOn) logCall();

if (pluginsOn && matches('plugins', '--help')) {
  console.log(`usage: muse plugins <command>

Commands:
  install <path> [--scope user|project] [--json]
  list [--available] [--json]
  inspect <id> [--json]
  approve <plugin-id> [--json]
  enable <id> [--json]
  disable <id> [--json]
  remove <id> [--json]
  validate <path> [--json]`);
} else if (pluginsOn && args[0] === 'plugins' && args[1] === 'validate') {
  const bundlePath = args[2];
  const manifest = bundlePath && existsSync(bundlePath) ? readBundleManifest(bundlePath) : null;
  const symlink = bundlePath && existsSync(bundlePath) ? findSymlink(bundlePath) : null;
  if (!manifest) {
    failJson('missing-manifest', 'plugin root must contain one supported plugin manifest');
  } else if (symlink) {
    failJson('invalid-plugin-package', `plugin contains symlink entries and cannot be installed: ${symlink}`);
  } else {
    console.log(
      JSON.stringify({ valid: true, source_path: bundlePath, plugin: { id: manifest.name }, diagnostics: [] }),
    );
  }
} else if (pluginsOn && args[0] === 'plugins' && args[1] === 'install') {
  const bundlePath = args[2];
  const manifest = bundlePath && existsSync(bundlePath) ? readBundleManifest(bundlePath) : null;
  const symlink = bundlePath && existsSync(bundlePath) ? findSymlink(bundlePath) : null;
  if (!manifest) {
    failJson('missing-manifest', 'plugin root must contain one supported plugin manifest');
  } else if (symlink) {
    failJson('invalid-plugin-package', `plugin contains symlink entries and cannot be installed: ${symlink}`);
  } else {
    const id = manifest.name;
    const skills = (manifest.capabilities?.skills ?? []).map((s) => s.id);
    const hooks = (manifest.capabilities?.hooks ?? []).map((h) => h.id);
    const mcp = (manifest.capabilities?.mcpServers ?? []).map((m) => m.id);
    // The live CLI copies the package into its own cache; the fake does the
    // same so doctor can resolve and spawn the cached entry point later.
    const cachePath = join(configRoot, 'fake-plugin-cache', id, 'package');
    rmSync(join(configRoot, 'fake-plugin-cache', id), { recursive: true, force: true });
    mkdirSync(join(configRoot, 'fake-plugin-cache', id), { recursive: true });
    cpSync(bundlePath, cachePath, { recursive: true });
    const store = readStore();
    store.plugins[id] = {
      id,
      version: manifest.version,
      enabled: true,
      skills,
      hooks,
      mcp,
      cachePath,
    };
    writeStore(store);
    console.log(JSON.stringify({ installed: { id, version: manifest.version, enabled: true } }));
  }
} else if (pluginsOn && args[0] === 'plugins' && args[1] === 'approve') {
  const store = readStore();
  const record = store.plugins[args[2]];
  if (!record) {
    failJson('plugin-not-found', `no installed plugin matches \`${args[2]}\``);
  } else {
    const runtime = [
      ...record.hooks.map((h) => `plugin:${record.id}:hook:${h}`),
      ...record.mcp.map((m) => `plugin:${record.id}:mcp_server:${m}`),
    ];
    if (runtime.length === 0) {
      failJson('runtime-capability-not-found', `no runtime capabilities match \`${record.id}\``);
    } else {
      console.log(
        JSON.stringify({
          decision: 'approve',
          runtime_capabilities: runtime.map((stable_id) => ({ stable_id, enabled: true })),
        }),
      );
    }
  }
} else if (pluginsOn && args[0] === 'plugins' && (args[1] === 'enable' || args[1] === 'disable')) {
  const store = readStore();
  const record = store.plugins[args[2]];
  if (!record) {
    failJson('plugin-not-found', `no installed plugin matches \`${args[2]}\``);
  } else {
    record.enabled = args[1] === 'enable';
    writeStore(store);
    console.log(JSON.stringify({ [args[1]]: { id: record.id, version: record.version, enabled: record.enabled } }));
  }
} else if (pluginsOn && matches('plugins', 'list', '--json')) {
  const store = readStore();
  console.log(
    JSON.stringify({
      plugins: Object.values(store.plugins).map((p) => ({
        record: {
          id: p.id,
          version: p.version,
          enabled: p.enabled,
          trust: 'user-local',
          cache_path: p.cachePath,
        },
        plugin: { id: p.id, version: p.version },
      })),
    }),
  );
} else if (pluginsOn && args[0] === 'plugins' && args[1] === 'inspect') {
  const record = readStore().plugins[args[2]];
  if (!record) {
    failJson('plugin-not-found', `no installed plugin matches \`${args[2]}\``);
  } else {
    console.log(
      JSON.stringify({
        record: {
          id: record.id,
          version: record.version,
          enabled: record.enabled,
          cache_path: record.cachePath,
        },
        plugin: { id: record.id, version: record.version },
        valid: true,
        active: record.enabled,
        diagnostics: [],
      }),
    );
  }
} else if (pluginsOn && args[0] === 'plugins' && args[1] === 'remove') {
  const store = readStore();
  if (!store.plugins[args[2]]) {
    failJson('plugin-not-found', `no installed plugin matches \`${args[2]}\``);
  } else {
    delete store.plugins[args[2]];
    writeStore(store);
    rmSync(join(configRoot, 'fake-plugin-cache', args[2]), { recursive: true, force: true });
    console.log(JSON.stringify({ removed: args[2] }));
  }
} else if (pluginsOn && args[0] === 'skills' && args[1] === 'list' && args[2] === '--source' && args[3] === 'plugin') {
  const store = readStore();
  const skills = [];
  for (const p of Object.values(store.plugins)) {
    if (!p.enabled) continue;
    for (const s of p.skills) skills.push({ id: `plugin:${p.id}:${s}`, name: `plugin:${p.id}:${s}` });
  }
  console.log(JSON.stringify({ skills, diagnostics: [] }));
} else if (matches('plugins', '--help')) {
  // Default mode simulates a plugins-off (≤1.1.1) build for the legacy
  // fallback-route tests; plugins-on behavior lives behind OMM_FAKE_PLUGINS.
  console.log('plugins are not available in this build');
} else if (matches('exec', '--provider', 'echo', '--permission-profile', '__omm_probe__', 'x')) {
  console.error('permission profile does not exist');
  process.exitCode = 1;
} else if (matches('config', 'status')) {
  console.log('plane=defaults state=present');
  console.log('plane=policy state=absent');
} else if (matches('skills', 'install', null, '--scope', 'user', '--force', '--json')) {
  const source = args[2];
  const id = basename(source);
  mkdirSync(skillsRoot, { recursive: true });
  cpSync(source, join(skillsRoot, id), { recursive: true });
  console.log(JSON.stringify({ id }));
} else if (matches('skills', 'uninstall', null, '--json')) {
  rmSync(join(skillsRoot, args[2]), { recursive: true, force: true });
  console.log(JSON.stringify({ id: args[2] }));
} else if (matches('skills', 'list', '--source', 'user', '--json')) {
  const ids = existsSync(skillsRoot)
    ? readdirSync(skillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];
  console.log(JSON.stringify({ skills: ids.map((id) => ({ id, name: id })), diagnostics: [] }));
} else {
  console.error(`unsupported fake muse command: ${args.join(' ')}`);
  process.exitCode = 1;
}
