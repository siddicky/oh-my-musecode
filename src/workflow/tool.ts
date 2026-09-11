/**
 * The in-loop workflow tool: one named entry point agents call explicitly.
 *
 * Construction performs no evaluation and dispatches nothing — runs start
 * only when the agent calls `run()`. The tool name and description come from
 * the workflow config (`toolName`, `systemPrompt`).
 */

import { WorkflowHost } from './host.js';
import { WorkflowInterpreter, type InterpreterOptions } from './interpreter.js';
import type { ToolResponse, WorkflowConfig } from './types.js';

export interface WorkflowTool {
  readonly name: string;
  readonly description: string;
  run(sessionId: string, code: string, overrides?: Partial<WorkflowConfig>): Promise<ToolResponse>;
  readonly interpreter: WorkflowInterpreter;
  readonly host: WorkflowHost;
}

const DEFAULT_SYSTEM_PROMPT = [
  'Evaluate JavaScript in a persistent QuickJS sandbox and return the result.',
  'Variables persist across calls in the same session.',
  'Call allowlisted host tools as await tools.camelCaseName(args).',
  'Dispatch subagents with await task({ description, subagentType, model, effort }).',
  'Subagent dispatches run as native workflow runs visible in /workflows.',
].join(' ');

export function createWorkflowTool(options: InterpreterOptions = {}): WorkflowTool {
  const interpreter = new WorkflowInterpreter(options);
  const config = interpreter.config;
  return {
    name: config.toolName,
    description: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    run: (sessionId: string, code: string, overrides: Partial<WorkflowConfig> = {}) =>
      interpreter.evaluate(sessionId, code, overrides),
    interpreter,
    host: interpreter.workflowHost,
  };
}
