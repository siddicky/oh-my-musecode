#!/usr/bin/env node
/**
 * Validates the plugin manifests against muse's native plugin contract.
 *
 * muse ships the authoritative contract with its bundled `create-plugin` skill
 * (`.../skills/create-plugin/references/native-plugin-contract.md`). On builds
 * through 1.1.1 the plugins subsystem was off, so this script enforced the
 * documented contract locally instead. On Muse 1.3.0-R3057.1
 * `muse plugins validate` runs, and this script's verdicts are diffed against
 * the live binary (see test/verify-manifest-diff.test.mjs).
 *
 * Deliberate strictness, not drift: the live 1.3.0 validator is lenient where
 * this script fails closed. A manifest declaring `agents` gets only a
 * `unsupported-capability` warning ("not supported in this phase") while its
 * definitions stay inactive; unknown capability fields warn `unsupported-field`
 * ("not used by this runtime"); `tools` passes silently. This script still
 * rejects all three, because a build gate that waves through capabilities the
 * runtime ignores is a silent-non-delivery bug with a green badge. Failing the
 * build is better than shipping a roster that validates yet never activates.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Test seam: the executable live-diff (test/verify-manifest-diff.test.mjs)
// points this at fixture bundle roots. Production runs leave it unset.
const ROOT = process.env.OMM_VERIFY_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');

const ACCEPTED_CAPABILITIES = new Set([
  'skills',
  'commands',
  'hooks',
  'mcpServers',
  'reminders',
]);

// Rejected outright by muse's validator.
const REJECTED_CAPABILITIES = new Set(['tools', 'agents', 'outputStyles', 'settings', 'apps']);

const HOOK_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'Notification',
]);

// Portable capability/plugin id grammar from the contract.
const ID_GRAMMAR = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const RESERVED_BASENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

const problems = [];

function readJson(relPath, { required }) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    if (required) problems.push(`${relPath}: missing`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    problems.push(`${relPath}: ${err.message}`);
    return null;
  }
}

/** Contract: relative UTF-8 paths, `/` separators, no traversal, no absolute paths. */
function checkRelativePath(label, value) {
  if (typeof value !== 'string' || value === '') {
    problems.push(`${label}: path must be a non-empty string`);
    return;
  }
  if (value.startsWith('/')) problems.push(`${label}: absolute paths are rejected (${value})`);
  if (value.includes('\\')) problems.push(`${label}: backslashes are rejected (${value})`);
  if (value.split('/').includes('..')) problems.push(`${label}: parent traversal is rejected (${value})`);
  if (!existsSync(join(ROOT, value))) problems.push(`${label}: referenced file does not exist (${value})`);
}

function checkId(label, id) {
  if (typeof id !== 'string' || !ID_GRAMMAR.test(id)) {
    problems.push(`${label}: id "${id}" does not match the portable id grammar`);
    return;
  }
  if (RESERVED_BASENAMES.has(id.split('.')[0].toLowerCase())) {
    problems.push(`${label}: id "${id}" case-folds to a reserved device name`);
  }
}

// ------------------------------------------------- native manifest (authoritative)

const native = readJson('.muse-plugin/plugin.json', { required: true });

if (native) {
  if (native.schemaVersion !== 1) problems.push('plugin.json: schemaVersion must be 1');
  if (!native.name) problems.push('plugin.json: missing `name`');
  else checkId('plugin.json name', native.name);
  if (native.name === 'loop' || native.name === 'muse-core') {
    problems.push(`plugin.json: plugin id "${native.name}" is reserved by the product bundle`);
  }
  if (!native.version) problems.push('plugin.json: missing `version`');
  if (!native.description) problems.push('plugin.json: missing `description`');
  if (native.compat?.source !== 'native') problems.push('plugin.json: compat.source must be "native"');
  if (native.compat?.manifestDir !== '.muse-plugin') {
    problems.push('plugin.json: compat.manifestDir must be ".muse-plugin"');
  }

  const caps = native.capabilities;
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    problems.push('plugin.json: `capabilities` must be an object');
  } else {
    for (const key of Object.keys(caps)) {
      if (REJECTED_CAPABILITIES.has(key)) {
        problems.push(
          `plugin.json: capability \`${key}\` is rejected by this gate and must not be declared` +
            ' (the live validator merely warns; see the header note on deliberate strictness)' +
            (key === 'agents'
              ? ' — personas are rendered into subagent prompts instead (see src/personas.ts)'
              : ''),
        );
      } else if (!ACCEPTED_CAPABILITIES.has(key)) {
        problems.push(`plugin.json: unknown capability \`${key}\``);
      } else if (!Array.isArray(caps[key])) {
        problems.push(`plugin.json: capability \`${key}\` must be an array`);
      }
    }

    for (const skill of caps.skills ?? []) {
      checkId('plugin.json skill', skill.id);
      checkRelativePath(`plugin.json skill ${skill.id}`, skill.path);
      if (!skill.path?.endsWith('SKILL.md')) {
        problems.push(`plugin.json skill ${skill.id}: path must target a SKILL.md`);
      }
    }

    for (const command of caps.commands ?? []) {
      checkId('plugin.json command', command.id);
      checkRelativePath(`plugin.json command ${command.id}`, command.path);
    }

    const hookSources = new Map();
    for (const hook of caps.hooks ?? []) {
      checkId('plugin.json hook', hook.id);
      if (!HOOK_EVENTS.has(hook.event)) {
        problems.push(`plugin.json hook ${hook.id}: unsupported event "${hook.event}"`);
      }
      if (!Array.isArray(hook.command) || hook.command.length === 0) {
        problems.push(`plugin.json hook ${hook.id}: command must be a structured argv array`);
        continue;
      }
      // Any argv element naming a relative source file must exist beneath the root.
      for (const arg of hook.command.slice(1)) {
        if (typeof arg === 'string' && arg.includes('/')) {
          checkRelativePath(`plugin.json hook ${hook.id}`, arg);
          // Contract: two hook ids may not share a source path.
          if (hookSources.has(arg)) {
            problems.push(
              `plugin.json hook ${hook.id}: shares source ${arg} with ${hookSources.get(arg)}`,
            );
          }
          hookSources.set(arg, hook.id);
        }
      }
    }

    for (const server of caps.mcpServers ?? []) {
      checkId('plugin.json mcpServer', server.id);
      if (server.transport && server.transport !== 'stdio' && !server.url) {
        problems.push(`plugin.json mcpServer ${server.id}: non-stdio transport requires a url`);
      }
      if (!Array.isArray(server.command) || server.command.length === 0) {
        problems.push(`plugin.json mcpServer ${server.id}: command must be a structured argv array`);
      }
    }
  }
}

// ------------------------------------------- Claude-family manifest (compatibility)

// Kept so the same tree can be consumed by Claude-family hosts. It is NOT the
// delivery mechanism for muse; it must simply not contradict the native manifest.
const marketplace = readJson('.claude-plugin/marketplace.json', { required: false });
if (marketplace) {
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    problems.push('marketplace.json: `plugins` must be a non-empty array');
  } else {
    for (const [i, plugin] of marketplace.plugins.entries()) {
      if (!plugin.source) problems.push(`marketplace.json: plugins[${i}] is missing \`source\``);
      if (!plugin.name) problems.push(`marketplace.json: plugins[${i}] is missing \`name\``);
    }
  }
}

const claude = readJson('.claude-plugin/plugin.json', { required: false });
if (claude?.capabilities) {
  for (const key of Object.keys(claude.capabilities)) {
    if (REJECTED_CAPABILITIES.has(key)) {
      problems.push(`.claude-plugin/plugin.json: capability \`${key}\` is rejected by this gate`);
    }
  }
}

// --------------------------------- manifest/skill-tree completeness
//
// Both manifests enumerate the skill corpus; a skill directory without a
// declaration loads nowhere on that path. The workflow skill shipped exactly
// this way, so drift fails the gate instead of failing silently.
const skillDirs = readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, 'skills', entry.name, 'SKILL.md')))
  .map((entry) => entry.name)
  .sort();
if (native) {
  const declaredIds = new Set((native.capabilities?.skills ?? []).map((skill) => skill.id));
  for (const dir of skillDirs) {
    if (!declaredIds.has(dir)) {
      problems.push(`plugin.json: skill "${dir}" exists under skills/ but is not declared`);
    }
  }
}
if (claude?.capabilities) {
  const claudeSkills = Array.isArray(claude.capabilities.skills) ? claude.capabilities.skills : [];
  const normalized = new Set(
    claudeSkills.filter((entry) => typeof entry === 'string').map((entry) => entry.replace(/^\.\//, '')),
  );
  for (const dir of skillDirs) {
    if (!normalized.has(`skills/${dir}`)) {
      problems.push(`.claude-plugin/plugin.json: skill "${dir}" exists under skills/ but is not listed`);
    }
  }
}

if (problems.length > 0) {
  console.error('Manifest verification FAILED:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('Manifest verification passed: native contract satisfied, no rejected capabilities.');
