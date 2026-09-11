/**
 * Shared types for the QuickJS dynamic-workflow tool.
 *
 * The interpreter runs agent-authored JavaScript in a WASM-sandboxed QuickJS
 * context. Two bridges cross that boundary: programmatic tool calling (PTC)
 * under the `tools` namespace, and subagent dispatch through the `task()`
 * global. Both bridges are caller-configured; nothing else crosses.
 */

export type PtcTool = (args: Record<string, unknown>) => unknown | Promise<unknown>;

/** Allowlist of host tools, keyed by original tool name (e.g. `web_search`). */
export type PtcAllowlist = Record<string, PtcTool>;

/** Caller-configured defaults for one subagent type. */
export interface SubagentDefault {
  model?: string;
  effort?: string;
}

/** Caller-provided map from subagent type to its defaults. */
export type SubagentMap = Record<string, SubagentDefault>;

/** One `task()` call from interpreter code, after defaults are merged. */
export interface TaskCall {
  description: string;
  subagentType: string;
  model?: string;
  effort?: string;
}

/** What the dispatcher receives for one dispatch attempt. */
export interface SubagentDispatch extends TaskCall {
  runId: string;
  attempt: number;
}

/** Host-side subagent runner. Returns the subagent's output text. */
export type SubagentDispatcher = (dispatch: SubagentDispatch) => Promise<string>;

export type WorkflowEventType = 'started' | 'progress' | 'completed' | 'cancelled';

export interface WorkflowEvent {
  type: WorkflowEventType;
  runId: string;
  attempt: number;
  subagentType: string;
  description: string;
  model: string;
  effort: string;
  outputLength?: number;
  error?: string;
}

export interface WorkflowConfig {
  memoryLimitBytes: number;
  maxStackSizeBytes: number;
  executionTimeoutMs: number;
  toolName: string;
  captureConsole: boolean;
  maxResultChars: number;
  systemPrompt: string | null;
  ptc: PtcAllowlist;
  maxPtcCalls: number | null;
  subagents: boolean;
}

/** Ralplan-confirmed tuned defaults for Muse Code CLI loops. */
export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  memoryLimitBytes: 32 * 1024 * 1024,
  maxStackSizeBytes: 256 * 1024,
  executionTimeoutMs: 8000,
  toolName: 'eval',
  captureConsole: true,
  maxResultChars: 8000,
  systemPrompt: null,
  ptc: {},
  maxPtcCalls: 64,
  subagents: true,
};

export interface ToolResponse {
  ok: boolean;
  result?: unknown;
  text: string;
  console: string[];
  truncated: boolean;
  error?: string;
}

/** `web_search` and `web-search` both become `webSearch`. */
export function toCamelCase(name: string): string {
  return name.replace(/[_-]+([a-zA-Z0-9])/g, (_, ch: string) => ch.toUpperCase());
}
