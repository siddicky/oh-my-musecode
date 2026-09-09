#!/usr/bin/env node
/**
 * UserPromptSubmit hook: suggest oh-my-musecode skills a prompt names.
 *
 * Restores oh-my-claudecode's keyword routing, which cannot come from frontmatter
 * here — muse's skill frontmatter profile has no `triggers` field, and skills are
 * invoke-only by design. The hook therefore surfaces the suggestion and stops.
 */

import { readPayload, emitContext } from './lib.mjs';
import { routePrompt, renderRoutingContext } from './routing.mjs';

const payload = await readPayload();
const prompt = payload.prompt ?? payload.user_prompt ?? '';

emitContext(renderRoutingContext(routePrompt(String(prompt))));
