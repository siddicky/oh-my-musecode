#!/usr/bin/env node
/**
 * omm-state: an MCP server exposing the .omm/ state root over stdio.
 *
 * Skills need somewhere durable to keep PRDs, specs and run state across turns.
 * That cannot be `.agents/` or `.muse/` — muse protects both — so this server is
 * the sanctioned way to reach `.omm/`.
 *
 * Every tool resolves its path through StateStore, which fails closed on a
 * protected or escaping path. A refusal is returned as a tool error rather than
 * thrown, so the model sees why it was refused and can correct itself.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { StateStore } from '../state.js';
import { loadPersonas, renderPersonaPrompt } from '../personas.js';
import { EscapedStateRootError, ProtectedPathError } from '../paths.js';

const store = new StateStore({
  workspaceRoot: process.env.MUSE_WORKSPACE_ROOT ?? process.cwd(),
});

/** Wraps a store call so a policy refusal becomes a legible tool error. */
function guarded(run: () => string): { content: { type: 'text'; text: string }[]; isError?: true } {
  try {
    return { content: [{ type: 'text', text: run() }] };
  } catch (err) {
    if (err instanceof ProtectedPathError || err instanceof EscapedStateRootError) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    throw err;
  }
}

const server = new McpServer(
  { name: 'omm-state', version: '0.1.0' },
  {
    instructions:
      'Durable state for oh-my-musecode, rooted at .omm/. Paths are relative to that ' +
      'root. Writes to .agents/ or .muse/ are refused: muse protects them.',
  },
);

server.registerTool(
  'state_read',
  {
    title: 'Read oh-my-musecode state',
    description:
      'Read a file from the .omm/ state root. Path is relative to .omm/. Returns an ' +
      'empty result when the file does not exist.',
    inputSchema: {
      path: z.string().describe('Path relative to the .omm/ state root, e.g. "state/ralph-state.json"'),
    },
  },
  async ({ path }) =>
    guarded(() => {
      const contents = store.read(path);
      return contents ?? `(no state at ${path})`;
    }),
);

server.registerTool(
  'state_write',
  {
    title: 'Write oh-my-musecode state',
    description:
      'Write a file into the .omm/ state root, creating parent directories. Path is ' +
      'relative to .omm/. Refuses any path that escapes the root or lands in a ' +
      'muse-protected directory (.agents/, .muse/, .git/).',
    inputSchema: {
      path: z.string().describe('Path relative to the .omm/ state root'),
      contents: z.string().describe('Full file contents to write'),
    },
  },
  async ({ path, contents }) =>
    guarded(() => `wrote ${store.write(path, contents)}`),
);

server.registerTool(
  'state_clear',
  {
    title: 'Clear oh-my-musecode state',
    description:
      'Remove a file or directory from the .omm/ state root. A missing target is a ' +
      'no-op. Subject to the same protected-path refusal as state_write.',
    inputSchema: {
      path: z.string().describe('Path relative to the .omm/ state root'),
    },
  },
  async ({ path }) =>
    guarded(() => (store.clear(path) ? `cleared ${path}` : `nothing to clear at ${path}`)),
);

server.registerTool(
  'persona_render',
  {
    title: 'Render an oh-my-musecode persona',
    description:
      'Return a persona\'s SOUL text and routing description, ready to interpolate into a ' +
      'subagent_spawn objective, plus the tool allowlist that child should be narrowed to. ' +
      'Personas are prompts, not muse agent definitions: muse rejects `agents` as a plugin ' +
      'capability, so the narrowing is advisory and the caller must apply it.',
    inputSchema: {
      id: z
        .string()
        .describe('Persona id, e.g. "executor", "critic", "verifier". Omit nothing; ids are exact.'),
    },
  },
  async ({ id }) => {
    try {
      const persona = loadPersonas().find((p) => p.id === id);
      const rendered = renderPersonaPrompt(id);
      const tools = persona ? persona.tools.join(', ') : '';
      return {
        content: [
          { type: 'text', text: `${rendered}\n\nNarrow this child's tools to: ${tools}` },
        ],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
    }
  },
);

server.registerTool(
  'persona_list',
  {
    title: 'List oh-my-musecode personas',
    description:
      'List every available persona id with its routing description, so a skill can choose ' +
      'the right one before calling persona_render.',
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: 'text',
        text: loadPersonas()
          .map((p) => `${p.id}: ${p.description}`)
          .join('\n'),
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
