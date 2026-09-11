#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
const configRoot = join(process.env.XDG_CONFIG_HOME, 'muse');
const skillsRoot = join(configRoot, 'skills');
const matches = (...expected) =>
  args.length === expected.length && expected.every((value, index) => value === null || value === args[index]);

if (matches('plugins', '--help')) {
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
