#!/usr/bin/env node

import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
const configRoot = join(process.env.XDG_CONFIG_HOME, 'muse');
const skillsRoot = join(configRoot, 'skills');

if (args[0] === 'plugins') {
  console.log('plugins are not available in this build');
} else if (args[0] === 'exec') {
  console.error('permission profile does not exist');
  process.exitCode = 1;
} else if (args[0] === 'config' && args[1] === 'status') {
  console.log('plane=defaults state=present');
  console.log('plane=policy state=absent');
} else if (args[0] === 'skills' && args[1] === 'install') {
  const source = args[2];
  const id = basename(source);
  mkdirSync(skillsRoot, { recursive: true });
  cpSync(source, join(skillsRoot, id), { recursive: true });
  console.log(JSON.stringify({ id }));
} else if (args[0] === 'skills' && args[1] === 'uninstall') {
  rmSync(join(skillsRoot, args[2]), { recursive: true, force: true });
  console.log(JSON.stringify({ id: args[2] }));
} else if (args[0] === 'skills' && args[1] === 'list') {
  const ids = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  console.log(JSON.stringify({ skills: ids.map((id) => ({ id, name: id })), diagnostics: [] }));
} else {
  console.error(`unsupported fake muse command: ${args.join(' ')}`);
  process.exitCode = 1;
}
