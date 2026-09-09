import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'mcp',
  'state-server.js',
);

/** Boots the server against a throwaway workspace and hands back a connected client. */
async function withClient(fn) {
  const workspace = mkdtempSync(join(tmpdir(), 'omm-mcp-'));
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER],
    env: { ...process.env, MUSE_WORKSPACE_ROOT: workspace },
  });
  const client = new Client({ name: 'omm-test', version: '0.0.0' });

  try {
    await client.connect(transport);
    return await fn(client, workspace);
  } finally {
    await client.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** Concatenates the text blocks of a tool result. */
const textOf = (result) =>
  result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

test('server completes an MCP initialize handshake', async () => {
  await withClient(async (client) => {
    const info = client.getServerVersion();
    assert.equal(info.name, 'omm-state');
  });
});

test('server lists its state and persona tools', async () => {
  await withClient(async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'persona_list',
      'persona_render',
      'state_clear',
      'state_read',
      'state_write',
    ]);
  });
});

test('persona_render gives skills a real consumer for the SOUL text', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: 'persona_render', arguments: { id: 'verifier' } });
    assert.ok(!result.isError, textOf(result));
    const text = textOf(result);
    assert.match(text, /What you do not do/, 'must carry the SOUL body');
    assert.match(text, /Narrow this child's tools to:/, 'must carry the tool allowlist');
    assert.match(text, /bash/, 'verifier must be able to run commands');
  });
});

test('persona_render refuses an unknown id as a tool error', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({ name: 'persona_render', arguments: { id: 'nope' } });
    assert.equal(result.isError, true);
  });
});

test('persona_list enumerates every persona with its routing description', async () => {
  await withClient(async (client) => {
    const text = textOf(await client.callTool({ name: 'persona_list', arguments: {} }));
    for (const id of ['executor', 'planner', 'architect', 'critic', 'explore',
                      'verifier', 'code-reviewer', 'debugger', 'writer', 'test-engineer']) {
      assert.match(text, new RegExp(`^${id}: `, 'm'), `${id} should be listed`);
    }
  });
});

test('state_write then state_read round-trips over the wire', async () => {
  await withClient(async (client, workspace) => {
    const written = await client.callTool({
      name: 'state_write',
      arguments: { path: 'state/run.json', contents: '{"active":true}' },
    });
    assert.ok(!written.isError, textOf(written));
    assert.ok(existsSync(join(workspace, '.omm', 'state', 'run.json')));

    const read = await client.callTool({
      name: 'state_read',
      arguments: { path: 'state/run.json' },
    });
    assert.equal(textOf(read), '{"active":true}');
  });
});

test('state_write refuses a protected path as a tool error, not a crash', async () => {
  await withClient(async (client, workspace) => {
    const result = await client.callTool({
      name: 'state_write',
      arguments: { path: '../../.agents/AGENTS.md', contents: 'pwned' },
    });

    assert.equal(result.isError, true, 'refusal must surface as a tool error');
    assert.match(textOf(result), /muse-protected path/);
    assert.ok(!existsSync(join(workspace, '.agents')), 'no .agents directory may be created');

    // The connection must survive a refusal so the model can correct itself.
    const after = await client.listTools();
    assert.equal(after.tools.length, 5);
  });
});

test('state_write refuses an escape that misses protected dirs', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'state_write',
      arguments: { path: '../escaped.txt', contents: 'nope' },
    });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /outside the state root/);
  });
});

test('state_read reports absence without erroring', async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: 'state_read',
      arguments: { path: 'state/missing.json' },
    });
    assert.ok(!result.isError);
    assert.match(textOf(result), /no state at/);
  });
});

test('state_clear removes a written file', async () => {
  await withClient(async (client, workspace) => {
    await client.callTool({
      name: 'state_write',
      arguments: { path: 'state/tmp.json', contents: '{}' },
    });
    const cleared = await client.callTool({
      name: 'state_clear',
      arguments: { path: 'state/tmp.json' },
    });
    assert.match(textOf(cleared), /cleared/);
    assert.ok(!existsSync(join(workspace, '.omm', 'state', 'tmp.json')));
  });
});
