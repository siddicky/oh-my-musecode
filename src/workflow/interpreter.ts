/**
 * WASM-sandboxed QuickJS interpreter with session-persistent state.
 *
 * Each session owns one QuickJS runtime and context, so variables survive
 * across `eval` calls while sessions stay isolated from each other. The only
 * bridges into the sandbox are the caller-configured PTC tools (`tools.*`)
 * and the `task()` subagent global. `Date` is removed from the sandbox: there
 * is no wall-clock unless the caller bridges an explicit time tool.
 */

import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';

import { WorkflowHost } from './host.js';
import { transformForEval } from './transform.js';
import {
  DEFAULT_WORKFLOW_CONFIG,
  toCamelCase,
  type PtcAllowlist,
  type SubagentDispatcher,
  type SubagentMap,
  type ToolResponse,
  type WorkflowConfig,
} from './types.js';

export interface InterpreterOptions {
  config?: Partial<WorkflowConfig>;
  subagentMap?: SubagentMap;
  dispatcher?: SubagentDispatcher;
  host?: WorkflowHost;
}

interface SessionState {
  runtime: QuickJSRuntime;
  context: QuickJSContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const encoded = JSON.stringify(value);
    return encoded ?? String(value);
  } catch {
    return String(value);
  }
}

export class WorkflowInterpreter {
  private readonly siteConfig: WorkflowConfig;
  private readonly subagentMap: SubagentMap;
  private readonly dispatcher: SubagentDispatcher | undefined;
  private readonly host: WorkflowHost;
  private modulePromise: Promise<QuickJSWASMModule> | undefined;
  private readonly sessions = new Map<string, SessionState>();

  constructor(options: InterpreterOptions = {}) {
    this.siteConfig = { ...DEFAULT_WORKFLOW_CONFIG, ...options.config };
    this.subagentMap = options.subagentMap ?? {};
    this.dispatcher = options.dispatcher;
    this.host = options.host ?? new WorkflowHost();
  }

  get config(): WorkflowConfig {
    return { ...this.siteConfig };
  }

  get workflowHost(): WorkflowHost {
    return this.host;
  }

  /**
   * Runs one `eval` call in the named session, creating the session on first
   * use. Per-call overrides win over the site config. Nothing runs without
   * this explicit call: construction performs no evaluation and dispatches
   * no subagents.
   */
  async evaluate(
    sessionId: string,
    code: string,
    overrides: Partial<WorkflowConfig> = {},
  ): Promise<ToolResponse> {
    const config: WorkflowConfig = { ...this.siteConfig, ...overrides };
    const session = await this.ensureSession(sessionId);
    const { runtime, context } = session;
    const deadline = Date.now() + config.executionTimeoutMs;
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
    runtime.setMemoryLimit(config.memoryLimitBytes);
    runtime.setMaxStackSize(config.maxStackSizeBytes);

    const consoleLines: string[] = [];
    const disposables: QuickJSHandle[] = [];
    const track = (handle: QuickJSHandle): QuickJSHandle => {
      disposables.push(handle);
      return handle;
    };
    let ptcCalls = 0;

    try {
      this.defineConsole(context, track, config.captureConsole, consoleLines);
      this.defineTools(context, track, config, () => {
        if (config.maxPtcCalls !== null && ++ptcCalls > config.maxPtcCalls) {
          throw new Error(
            `maxPtcCalls of ${config.maxPtcCalls} exceeded; no further tool invocations are performed.`,
          );
        }
      });
      this.defineTask(context, track, config);

      // The transform hoists declarations, auto-returns a trailing
      // expression, and wraps everything in an async IIFE so top-level
      // await works despite QuickJS parsing script-mode `await` as an
      // identifier.
      const evalResult = context.evalCode(transformForEval(code), 'workflow-eval');
      if (evalResult.error) {
        const message = formatConsoleArg(context.dump(evalResult.error));
        evalResult.error.dispose();
        return this.respond(undefined, consoleLines, config, `Eval failed: ${message}`);
      }
      const resultHandle = evalResult.value;
      try {
        const settled = await this.pumpToSettled(runtime, context, resultHandle, deadline);
        if (settled.status === 'timeout') {
          this.dropSession(sessionId);
          return this.respond(
            undefined,
            consoleLines,
            config,
            `Eval timed out after ${config.executionTimeoutMs}ms.`,
          );
        }
        if (settled.status === 'rejected') {
          return this.respond(
            undefined,
            consoleLines,
            config,
            `Eval failed: ${settled.message}`,
          );
        }
        return this.respond(settled.value, consoleLines, config);
      } finally {
        resultHandle.dispose();
      }
    } finally {
      runtime.setInterruptHandler(() => false);
      for (const handle of disposables.splice(0)) {
        try {
          handle.dispose();
        } catch {
          // Handles owned by still-pending VM objects dispose with their owner.
        }
      }
    }
  }

  disposeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.context.dispose();
    session.runtime.dispose();
  }

  disposeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.disposeSession(sessionId);
    }
  }

  private async ensureSession(sessionId: string): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    if (!this.modulePromise) this.modulePromise = getQuickJS();
    const module = await this.modulePromise;
    const runtime = module.newRuntime();
    const context = runtime.newContext();
    // No wall-clock in the sandbox unless bridged through PTC.
    context.evalCode('delete globalThis.Date;');
    const session: SessionState = { runtime, context };
    this.sessions.set(sessionId, session);
    return session;
  }

  private dropSession(sessionId: string): void {
    // A timed-out session may hold stuck jobs; start clean next call rather
    // than resuming a context that can no longer make progress.
    try {
      this.disposeSession(sessionId);
    } catch {
      this.sessions.delete(sessionId);
    }
  }

  private defineConsole(
    context: QuickJSContext,
    track: (handle: QuickJSHandle) => QuickJSHandle,
    capture: boolean,
    lines: string[],
  ): void {
    const consoleObj = track(context.newObject());
    for (const level of ['log', 'warn', 'error']) {
      const fn = track(
        context.newFunction(level, (...argHandles) => {
          if (capture) {
            lines.push(argHandles.map((arg) => formatConsoleArg(context.dump(arg))).join(' '));
          }
        }),
      );
      context.setProp(consoleObj, level, fn);
    }
    context.setProp(context.global, 'console', consoleObj);
  }

  private defineTools(
    context: QuickJSContext,
    track: (handle: QuickJSHandle) => QuickJSHandle,
    config: WorkflowConfig,
    beforeCall: () => void,
  ): void {
    const allowlist: PtcAllowlist = config.ptc;
    const toolsObj = track(context.newObject());
    for (const [originalName, tool] of Object.entries(allowlist)) {
      const name = toCamelCase(originalName);
      const fn = track(
        context.newFunction(name, (...argHandles) => {
          beforeCall();
          const rawArgs = argHandles.length > 0 ? context.dump(argHandles[0]) : {};
          const args = isRecord(rawArgs) ? rawArgs : {};
          const runtime = (context.runtime ?? undefined) as QuickJSRuntime | undefined;
          const deferred = context.newPromise();
          Promise.resolve()
            .then(() => tool(args))
            .then(
              (native) => {
                const valueHandle = this.fromNative(context, native);
                deferred.resolve(valueHandle);
                valueHandle.dispose();
                runtime?.executePendingJobs();
              },
              (error: unknown) => {
                const messageHandle = context.newString(errorMessage(error));
                deferred.reject(messageHandle);
                messageHandle.dispose();
                runtime?.executePendingJobs();
              },
            );
          return deferred.handle;
        }),
      );
      context.setProp(toolsObj, name, fn);
    }
    context.setProp(context.global, 'tools', toolsObj);
  }

  private defineTask(
    context: QuickJSContext,
    track: (handle: QuickJSHandle) => QuickJSHandle,
    config: WorkflowConfig,
  ): void {
    if (!config.subagents) {
      context.evalCode('delete globalThis.task;');
      return;
    }
    const dispatcher = this.dispatcher;
    const subagentMap = this.subagentMap;
    const host = this.host;
    const fn = track(
      context.newFunction('task', (...argHandles) => {
        const raw = argHandles.length > 0 ? context.dump(argHandles[0]) : undefined;
        if (!isRecord(raw)) {
          throw new Error('task() requires an argument object.');
        }
        const description = raw['description'];
        const subagentType = raw['subagentType'];
        if (typeof description !== 'string' || description.length === 0) {
          throw new Error('task() requires a non-empty string "description".');
        }
        if (typeof subagentType !== 'string' || subagentType.length === 0) {
          throw new Error('task() requires a non-empty string "subagentType".');
        }
        const defaults = subagentMap[subagentType];
        if (!defaults) {
          const known = Object.keys(subagentMap).sort().join(', ');
          throw new Error(
            `Unknown subagent type "${subagentType}".` +
              (known.length > 0 ? ` Known types are: ${known}.` : ' No subagent types are mapped.'),
          );
        }
        if (!dispatcher) {
          throw new Error('task() has no dispatcher configured.');
        }
        const model = typeof raw['model'] === 'string' ? raw['model'] : defaults.model;
        const effort = typeof raw['effort'] === 'string' ? raw['effort'] : defaults.effort;
        if (typeof model !== 'string' || model.length === 0) {
          throw new Error(`task() for "${subagentType}" has no model: pass one or map a default.`);
        }
        if (typeof effort !== 'string' || effort.length === 0) {
          throw new Error(`task() for "${subagentType}" has no effort: pass one or map a default.`);
        }
        const runtime = (context.runtime ?? undefined) as QuickJSRuntime | undefined;
        const deferred = context.newPromise();
        const request = { description, subagentType, model, effort };
        Promise.resolve()
          .then(() => host.run(request, dispatcher))
          .then(
            (output) => {
              const valueHandle = context.newString(output);
              deferred.resolve(valueHandle);
              valueHandle.dispose();
              runtime?.executePendingJobs();
            },
            (error: unknown) => {
              const messageHandle = context.newString(errorMessage(error));
              deferred.reject(messageHandle);
              messageHandle.dispose();
              runtime?.executePendingJobs();
            },
          );
        return deferred.handle;
      }),
    );
    context.setProp(context.global, 'task', fn);
  }

  private fromNative(context: QuickJSContext, native: unknown): QuickJSHandle {
    if (native === undefined) return context.undefined;
    const encoded = JSON.stringify(native);
    if (encoded === undefined) return context.undefined;
    const parsed = context.evalCode(`(${encoded})`, 'workflow-value');
    if (parsed.error) {
      const message = formatConsoleArg(context.dump(parsed.error));
      parsed.error.dispose();
      throw new Error(`Cannot bridge host value into the sandbox: ${message}`);
    }
    return parsed.value;
  }

  private async pumpToSettled(
    runtime: QuickJSRuntime,
    context: QuickJSContext,
    handle: QuickJSHandle,
    deadline: number,
  ): Promise<
    | { status: 'fulfilled'; value: unknown }
    | { status: 'rejected'; message: string }
    | { status: 'timeout' }
  > {
    for (;;) {
      runtime.executePendingJobs();
      const state = context.getPromiseState(handle);
      if (state.type === 'fulfilled') {
        const value = context.dump(state.value);
        // A non-promise result reports the original handle (notAPromise), so
        // only a genuine promise result owns a handle that needs disposing.
        if (!state.notAPromise) state.value.dispose();
        return { status: 'fulfilled', value };
      }
      if (state.type === 'rejected') {
        const message = formatConsoleArg(context.dump(state.error));
        state.error.dispose();
        return { status: 'rejected', message };
      }
      if (Date.now() > deadline) return { status: 'timeout' };
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private respond(
    result: unknown,
    consoleLines: string[],
    config: WorkflowConfig,
    error?: string,
  ): ToolResponse {
    const text =
      typeof result === 'string' ? result : result === undefined ? '' : JSON.stringify(result);
    const truncated = text.length > config.maxResultChars;
    return {
      ok: error === undefined,
      ...(result === undefined ? {} : { result }),
      text: truncated ? text.slice(0, config.maxResultChars) : text,
      console: consoleLines,
      truncated,
      ...(error === undefined ? {} : { error }),
    };
  }
}
