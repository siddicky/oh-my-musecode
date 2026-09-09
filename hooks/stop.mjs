#!/usr/bin/env node
/**
 * Stop hook: hold the verification gate open while a ralph run is active.
 *
 * oh-my-claudecode's ralph must not declare completion without reviewer sign-off.
 * Skill bodies alone cannot enforce that here, because a skill only shapes the one
 * turn it was invoked on — by the time the model is stopping, the ralph skill body
 * may be many turns behind it. The Stop hook is the only surface that sees every
 * end-of-turn, so it is where the reminder belongs.
 *
 * It reminds; it does not block.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPayload, workspaceRootFrom, emitContext } from './lib.mjs';

const payload = await readPayload();
const statePath = join(workspaceRootFrom(payload), '.omm', 'state', 'ralph-state.json');

/** @returns {Record<string, any> | null} */
function readRalphState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // Absent or unreadable state means no active run to gate.
    return null;
  }
}

const state = readRalphState();

if (!state?.active) {
  emitContext(null);
}

const reviewer = state.critic_mode ?? 'architect';
const story = state.current_story ? ` (current story: ${state.current_story})` : '';

emitContext(
  [
    `oh-my-musecode: a ralph run is still active${story}.`,
    '',
    'Before claiming completion, confirm:',
    '  - every prd.json story has passes: true against its own acceptance criteria',
    `  - the ${reviewer} reviewer has approved this run`,
    '  - a fresh build/test run was read, not assumed',
    '',
    'If the run is genuinely finished, invoke /cancel to clear state.',
  ].join('\n'),
);
