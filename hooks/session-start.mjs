#!/usr/bin/env node
/**
 * SessionStart hook: make sure the .omm/ state root exists.
 *
 * State lives in .omm/ and never in .agents/ or .muse/: muse protects both, so a
 * mediated write there is held for human review and a shell write fails read-only
 * at the sandbox. This hook only ever creates .omm/, so it takes no untrusted path
 * input and needs no path-policy check.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readPayload, workspaceRootFrom, emitContext } from './lib.mjs';

const payload = await readPayload();
const stateRoot = join(workspaceRootFrom(payload), '.omm');

let created = false;
if (!existsSync(stateRoot)) {
  try {
    mkdirSync(join(stateRoot, 'state'), { recursive: true });
    created = true;
  } catch (err) {
    // A session that cannot create state is still a usable session; say so and
    // carry on rather than failing the user's startup.
    emitContext(`oh-my-musecode: could not create ${stateRoot} (${err.message}).`);
  }
}

emitContext(
  created
    ? `oh-my-musecode: initialised state root at ${stateRoot}.`
    : null,
);
