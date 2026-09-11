#!/usr/bin/env node
/**
 * Unleashed PTC demo: repo reconnaissance.
 *
 * The same agent-authored script runs twice. First guarded with a
 * deliberately tiny maxPtcCalls=3, where it trips the cap. Then unleashed
 * with the same cap configured, where it sails through: one static
 * allowlist tool plus two resolver-provided tools the script discovers
 * dynamically. A third eval shows session persistence.
 *
 * Run from the repo root (after `npm run build`):
 *   node examples/unleashed-recon.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkflowInterpreter } from '../dist/workflow/index.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function safeJoin(requested) {
  const absolute = resolve(ROOT, requested);
  if (absolute !== ROOT && !absolute.startsWith(ROOT + sep)) {
    throw new Error(`refused path outside the repo: ${requested}`);
  }
  return absolute;
}

const seen = [];
function record(kind, name, detail) {
  seen.push({ kind, name });
  console.log(`  [host] tools.${name} (${kind}) -> ${detail}`);
}

const toolbox = {
  listDir: async ({ path }) => {
    const entries = readdirSync(safeJoin(path), { withFileTypes: true })
      .map((entry) => entry.name)
      .sort();
    record('resolved dynamically', 'listDir', `${entries.length} entries`);
    return entries;
  },
  readFile: async ({ path }) => {
    const text = readFileSync(safeJoin(path), 'utf8');
    record('resolved dynamically', 'readFile', `${text.length} chars`);
    return text;
  },
};

const interpreter = new WorkflowInterpreter({
  config: {
    maxPtcCalls: 3,
    ptc: {
      repo_name: async () => {
        record('static allowlist', 'repoName', '"oh-my-musecode"');
        return 'oh-my-musecode';
      },
    },
  },
  toolResolver: (name) => toolbox[name],
});

const GUARDED_SCRIPT = `let last = '';
for (let i = 0; i < 5; i++) { last = await tools.repoName({}); }
last;`;

const SCRIPT = `const repo = await tools.repoName({});
const files = (await tools.listDir({ path: 'src/workflow' }))
  .filter((f) => f.endsWith('.ts'));
const sizes = [];
for (const file of files) {
  const text = await tools.readFile({ path: 'src/workflow/' + file });
  sizes.push(file + ': ' + text.split('\\n').length + ' lines');
}
globalThis.recon = { repo, sources: files.length };
sizes.join('\\n');`;

console.log('=== unleashed PTC demo: repo reconnaissance ===');
console.log('config: maxPtcCalls=3 (deliberately tiny)\n');
console.log('--- the agent-authored script ---');
console.log(SCRIPT);

console.log('\n--- attempt 1: guarded mode (5 listed calls, cap is 3) ---');
seen.length = 0;
const guarded = await interpreter.evaluate('recon-guarded', GUARDED_SCRIPT);
console.log(`result: ok=${guarded.ok}`);
console.log(`error: ${guarded.error}`);
console.log(`host observed ${seen.length} tool call(s) before the cap tripped.`);
const closed = await interpreter.evaluate('recon-guarded', 'typeof tools.listDir;');
console.log(`closed world check: typeof tools.listDir -> ${closed.result}`);

console.log('\n--- attempt 2: unleashed mode (same cap configured) ---');
seen.length = 0;
const unleashed = await interpreter.evaluate('recon-unleashed', SCRIPT, { ptcMode: 'unleashed' });
console.log(`result: ok=${unleashed.ok}`);
console.log(`host observed ${seen.length} tool call(s); cap ignored.`);
console.log('report:');
for (const line of String(unleashed.result).split('\n')) {
  console.log(`  ${line}`);
}

console.log('\n--- attempt 3: session persistence ---');
const recall = await interpreter.evaluate(
  'recon-unleashed',
  '`${recon.repo} has ${recon.sources} workflow sources; longest is shown above.`;',
);
console.log(`recall: ${recall.result}`);

interpreter.disposeAll();
console.log('\n=== done ===');
