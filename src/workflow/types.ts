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

/**
 * `guarded` (default) exposes exactly the static `ptc` allowlist and enforces
 * `maxPtcCalls`. `unleashed` drops the call cap and resolves any other tool
 * name through the host's `toolResolver`, so scripts see the widest tool path
 * the host offers. Unleashed mode does not lift sandbox limits (memory, stack,
 * timeout) or result truncation — only the PTC restrictions.
 */
export type PtcMode = 'guarded' | 'unleashed';

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
  /**
   * Aborts when the host cancels (reason `'cancelled'`) or restarts (reason
   * `'restart'`) this attempt. A fresh signal is issued per attempt. The host
   * ignores the late result either way, but dispatchers should stop work on
   * abort to avoid zombie side effects.
   */
  signal: AbortSignal;
}

/** Host-side subagent runner. Returns the subagent's output text. */
export type SubagentDispatcher = (dispatch: SubagentDispatch) => Promise<string>;

export type WorkflowEventType = 'started' | 'progress' | 'completed' | 'cancelled';

/**
 * Which bridge produced the event: a `task()` subagent dispatch or a PTC
 * tool call. UI adapters filter on this before projecting run lists.
 */
export type WorkflowEventKind = 'subagent' | 'ptc';

/** Lifecycle of one `task()` subagent dispatch, as a workflow UI run row. */
export interface WorkflowSubagentEvent {
  kind: 'subagent';
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

/** PTC tool calls are single-shot: one started event, then completed on success. */
export type WorkflowPtcEventType = 'started' | 'completed';

export interface WorkflowPtcEvent {
  kind: 'ptc';
  type: WorkflowPtcEventType;
  /** `ptc-N` from a host-local counter; never collides with `run-N` ids. */
  toolCallId: string;
  /**
   * Guarded mode: the original allowlist name (`web_search`). Unleashed
   * mode: the exact property name accessed on `tools`.
   */
  tool: string;
  /** Length of the JSON-encoded tool result. Absent when unserializable. */
  outputLength?: number;
  error?: string;
}

/**
 * One row in the UI event stream. A throwing tool emits no terminal event —
 * mirroring a failed subagent dispatch — and refused calls (un-allowlisted,
 * cap-exceeded) emit nothing at all: refusal is the thrown error, never a row.
 */
export type WorkflowEvent = WorkflowSubagentEvent | WorkflowPtcEvent;

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
  ptcMode: PtcMode;
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
  ptcMode: 'guarded',
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
