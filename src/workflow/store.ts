/**
 * Save and reuse for named interpreter workflows.
 *
 * A saved workflow is its script plus the configuration needed to replay it:
 * PTC tool names, the subagent map with model/effort defaults, and the
 * tuned limits. Re-running resolves tool names against caller-supplied
 * implementations, so stored definitions never serialize functions.
 */

import { StateStore } from '../state.js';
import { WorkflowInterpreter } from './interpreter.js';
import type { SubagentDispatcher, SubagentMap, ToolResponse, WorkflowConfig } from './types.js';
import type { PtcAllowlist } from './types.js';

export interface WorkflowLimits {
  memoryLimitBytes: number;
  maxStackSizeBytes: number;
  executionTimeoutMs: number;
  maxResultChars: number;
  maxPtcCalls: number | null;
}

export interface SavedWorkflow {
  name: string;
  script: string;
  ptc: string[];
  subagentMap: SubagentMap;
  limits: WorkflowLimits;
  createdAt: string;
}

export interface SaveWorkflowInput {
  name: string;
  script: string;
  ptc?: string[];
  subagentMap?: SubagentMap;
  limits?: Partial<WorkflowLimits>;
}

const WORKFLOWS_PREFIX = 'workflows';
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

function workflowPath(name: string): string {
  return `${WORKFLOWS_PREFIX}/${name}.json`;
}

function checkName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid workflow name "${name}": use letters, digits, "-" or "_" only.`,
    );
  }
}

export function saveWorkflow(store: StateStore, input: SaveWorkflowInput): SavedWorkflow {
  checkName(input.name);
  if (input.script.length === 0) {
    throw new Error('Cannot save a workflow with an empty script.');
  }
  const saved: SavedWorkflow = {
    name: input.name,
    script: input.script,
    ptc: [...(input.ptc ?? [])],
    subagentMap: input.subagentMap ?? {},
    limits: {
      memoryLimitBytes: 32 * 1024 * 1024,
      maxStackSizeBytes: 256 * 1024,
      executionTimeoutMs: 8000,
      maxResultChars: 8000,
      maxPtcCalls: 64,
      ...input.limits,
    },
    createdAt: new Date().toISOString(),
  };
  store.write(workflowPath(input.name), JSON.stringify(saved, null, 2));
  const names = listWorkflows(store);
  if (!names.includes(saved.name)) {
    writeIndex(store, [...names, saved.name]);
  }
  return saved;
}

export function listWorkflows(store: StateStore): string[] {
  // StateStore has no directory listing, so track names in an index file.
  const raw = store.read(`${WORKFLOWS_PREFIX}/index.json`);
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string').sort();
}

export function loadWorkflow(store: StateStore, name: string): SavedWorkflow {
  checkName(name);
  const raw = store.read(workflowPath(name));
  if (raw === null) {
    throw new Error(`Unknown workflow "${name}": nothing saved under that name.`);
  }
  return JSON.parse(raw) as SavedWorkflow;
}

export function deleteWorkflow(store: StateStore, name: string): boolean {
  checkName(name);
  const removed = store.clear(workflowPath(name));
  writeIndex(store, listWorkflows(store).filter((entry) => entry !== name));
  return removed;
}

export interface RunSavedWorkflowOptions {
  tools: PtcAllowlist;
  dispatcher?: SubagentDispatcher;
  sessionId?: string;
  runCounter?: number;
}

let runSequence = 0;

export async function runWorkflow(
  store: StateStore,
  name: string,
  options: RunSavedWorkflowOptions,
): Promise<ToolResponse> {
  const saved = loadWorkflow(store, name);
  const allowlist: PtcAllowlist = {};
  for (const toolName of saved.ptc) {
    const tool = options.tools[toolName];
    if (!tool) {
      throw new Error(`Saved workflow "${name}" needs tool "${toolName}", which was not supplied.`);
    }
    allowlist[toolName] = tool;
  }
  const interpreter = new WorkflowInterpreter({
    config: {
      memoryLimitBytes: saved.limits.memoryLimitBytes,
      maxStackSizeBytes: saved.limits.maxStackSizeBytes,
      executionTimeoutMs: saved.limits.executionTimeoutMs,
      maxResultChars: saved.limits.maxResultChars,
      maxPtcCalls: saved.limits.maxPtcCalls,
      ptc: allowlist,
    },
    subagentMap: saved.subagentMap,
    dispatcher: options.dispatcher,
  });
  try {
    const sessionId = options.sessionId ?? `saved:${name}:${++runSequence}`;
    return await interpreter.evaluate(sessionId, saved.script);
  } finally {
    interpreter.disposeAll();
  }
}

function writeIndex(store: StateStore, names: string[]): void {
  store.write(`${WORKFLOWS_PREFIX}/index.json`, JSON.stringify([...names].sort(), null, 2));
}

export type { WorkflowConfig };
