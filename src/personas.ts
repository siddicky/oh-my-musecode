/**
 * Persona loading and prompt rendering.
 *
 * On builds through 1.1.1 muse rejected `agents` as a plugin capability: a
 * Claude-family plugin that declared it still loaded, but the definitions were
 * reported `agent-overlay-inactive` and never activated (see
 * scripts/verify-manifest.mjs).
 *
 * US-005 verdict — `--agents` overlay explicitly NOT integrated, for three
 * probed reasons (see docs/live-probes-1.3.0.md). First, `--agents` is
 * session-startup CLI surface ("Session Agent Definition JSON", a JSON
 * object): this module operates at `subagent_spawn(role, objective)` call
 * time inside a session, and no code path here starts a session or passes
 * CLI flags at dispatch, so there is no layer where one could consume the
 * other. Second, declaring personas via the manifest `agents` capability is
 * still closed: live 1.3.0 warns `unsupported-capability` ("not supported in
 * this phase") and leaves the definitions inactive. Third, the overlay's
 * inner schema and roster effects are unobservable headlessly, so any
 * SOUL-to-overlay mapping would be speculation, not verified behavior.
 * Personas therefore stay plain data (a SOUL.md
 * body plus a routing description and a narrowed toolset) that skills read and
 * interpolate into a `subagent_spawn(role, objective)` prompt at call time. This
 * module is the single place that resolves that data off disk.
 *
 * Each persona is a SOUL: the agent's "who," never the project's "what." Workspace
 * paths, stack choices, and handoff formats belong in AGENTS.md / a runbook, not here.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Personas directory, resolved relative to this module rather than the process
 * cwd, so loading works the same whether this runs from src/ under ts-node or
 * from the compiled dist/ output.
 */
const PERSONAS_DIR = join(MODULE_DIR, '..', 'personas');

export interface Persona {
  /** Matches the persona's directory name under personas/. */
  readonly id: string;
  /** Routing surface: what another agent reads to decide whether this persona fits. */
  readonly description: string;
  /** Narrowed toolset. Never widens whatever the spawning context already grants. */
  readonly tools: readonly string[];
  /** Full SOUL.md body: the persona's "who". */
  readonly soul: string;
}

interface ManifestEntry {
  id: string;
  description: string;
  tools: unknown;
}

interface Manifest {
  personas: ManifestEntry[];
}

function readManifest(): Manifest {
  const manifestPath = join(PERSONAS_DIR, 'manifest.json');
  const raw = readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as Manifest;
}

function readSoul(id: string): string {
  const soulPath = join(PERSONAS_DIR, id, 'SOUL.md');
  try {
    return readFileSync(soulPath, 'utf8').trim();
  } catch (err) {
    throw new Error(
      `Persona "${id}" is listed in manifest.json but has no SOUL.md at ${soulPath}.`,
      { cause: err },
    );
  }
}

let cachedPersonas: Persona[] | undefined;

/**
 * Loads every persona declared in personas/manifest.json, reading its SOUL.md
 * from disk. Throws if the manifest and the SOUL.md files on disk disagree, or
 * if any persona's `tools` array is empty (muse semantics: a child's tools may
 * only narrow the inherited grant, never widen it — an empty toolset is a
 * persona that can be spawned but can do nothing, which is never intended here).
 */
export function loadPersonas(): Persona[] {
  if (cachedPersonas) return cachedPersonas;

  const manifest = readManifest();
  if (!Array.isArray(manifest.personas) || manifest.personas.length === 0) {
    throw new Error(`personas/manifest.json must declare a non-empty "personas" array.`);
  }

  const seenIds = new Set<string>();
  const personas: Persona[] = manifest.personas.map((entry) => {
    if (!entry.id || typeof entry.id !== 'string') {
      throw new Error(`personas/manifest.json has an entry with a missing or invalid "id".`);
    }
    if (!entry.description || typeof entry.description !== 'string') {
      throw new Error(`Persona "${entry.id}" is missing a "description" in manifest.json.`);
    }
    if (!Array.isArray(entry.tools) || entry.tools.length === 0) {
      throw new Error(
        `Persona "${entry.id}" has an empty "tools" array in manifest.json. ` +
          `Every persona must declare at least one narrowed tool.`,
      );
    }
    seenIds.add(entry.id);
    return {
      id: entry.id,
      description: entry.description,
      tools: Object.freeze([...entry.tools]) as readonly string[],
      soul: readSoul(entry.id),
    };
  });

  cachedPersonas = personas;
  return personas;
}

/**
 * Renders a persona's prompt for interpolation into a `subagent_spawn(role,
 * objective)` call: the SOUL body, followed by its routing description as
 * additional framing context.
 *
 * @throws {Error} naming the valid ids, if `id` does not match a loaded persona
 */
export function renderPersonaPrompt(id: string): string {
  const personas = loadPersonas();
  const persona = personas.find((p) => p.id === id);
  if (!persona) {
    const validIds = personas.map((p) => p.id).join(', ');
    throw new Error(`Unknown persona "${id}". Valid persona ids are: ${validIds}.`);
  }

  return `${persona.soul}\n\n## Role in this task\n\n${persona.description}`;
}
