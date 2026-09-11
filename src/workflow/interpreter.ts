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
  type PtcTool,
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
  /** Overrides WASM module loading; defaults to getQuickJS(). A test seam for load failure. */
  moduleLoader?: () => Promise<QuickJSWASMModule>;
  /**
   * Resolves tool names beyond the static allowlist when `ptcMode` is
   * `'unleashed'`. Receives the exact property name accessed on `tools` and
   * returns the tool, or `undefined` for unknown names. Must be synchronous
   * and cheap; it runs on every tool access. Ignored in guarded mode.
   */
  toolResolver?: (name: string) => PtcTool | undefined;
}

type PendingPromise = ReturnType<QuickJSContext['newPromise']>;

interface SessionState {
  runtime: QuickJSRuntime;
  context: QuickJSContext;
  /** Deferreds awaiting host work; disposed before teardown so no live handles survive. */
  inflight: Set<PendingPromise>;
}

/** Identifies the session a host-bridge continuation belongs to. */
interface BridgeScope {
  session: SessionState;
  sessionId: string;
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

/**
 * Builds the unleashed `tools` proxy: every property access resolves through
 * the host, and unresolvable names stay absent. The bridge functions are
 * captured by the closure and deleted from global scope so agent code sees
 * only `tools`.
 */
const UNLEASHED_TOOLS_SETUP = `globalThis.tools = (() => {
  const has = globalThis.__ptcHas;
  const call = globalThis.__ptcCall;
  const proxy = new Proxy({}, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      if (has(property) !== 1) return undefined;
      return (args) => call(property, args);
    },
    has(_target, property) {
      return typeof property === 'string' && has(property) === 1;
    },
  });
  delete globalThis.__ptcHas;
  delete globalThis.__ptcCall;
  return proxy;
})();`;

export class WorkflowInterpreter {
  private readonly siteConfig: WorkflowConfig;
  private readonly subagentMap: SubagentMap;
  private readonly dispatcher: SubagentDispatcher | undefined;
  private readonly host: WorkflowHost;
  private readonly toolResolver: ((name: string) => PtcTool | undefined) | undefined;
  private readonly moduleLoader: () => Promise<QuickJSWASMModule>;
  private modulePromise: Promise<QuickJSWASMModule> | undefined;
  private readonly sessions = new Map<string, SessionState>();
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(options: InterpreterOptions = {}) {
    this.siteConfig = { ...DEFAULT_WORKFLOW_CONFIG, ...options.config };
    this.subagentMap = options.subagentMap ?? {};
    this.dispatcher = options.dispatcher;
    this.host = options.host ?? new WorkflowHost();
    this.toolResolver = options.toolResolver;
    this.moduleLoader = options.moduleLoader ?? getQuickJS;
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
   *
   * Concurrent calls on the same session are serialized: one QuickJS context
   * serves a session, so parallel evals would share globals, deadlines, and
   * handle cleanup. Different sessions still run in parallel.
   */
  async evaluate(
    sessionId: string,
    code: string,
    overrides: Partial<WorkflowConfig> = {},
  ): Promise<ToolResponse> {
    const prior = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prior.catch(() => undefined).then(() => current);
    this.sessionLocks.set(sessionId, chained);
    await prior.catch(() => undefined);
    try {
      return await this.evaluateLocked(sessionId, code, overrides);
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === chained) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  private async evaluateLocked(
    sessionId: string,
    code: string,
    overrides: Partial<WorkflowConfig>,
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
    let timedOut = false;

    try {
      const scope: BridgeScope = { session, sessionId };
      this.defineConsole(context, track, config.captureConsole, consoleLines);
      this.defineTools(context, track, config, scope, () => {
        if (config.maxPtcCalls !== null && ++ptcCalls > config.maxPtcCalls) {
          throw new Error(
            `maxPtcCalls of ${config.maxPtcCalls} exceeded; no further tool invocations are performed.`,
          );
        }
      });
      this.defineTask(context, track, config, scope);

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
          // Flagged, not dropped here: every held handle is disposed in the
          // finally blocks below, and the runtime is freed only once no
          // native references survive. Freeing it earlier trips a QuickJS
          // gc-list assertion when bridged promises are still in flight.
          timedOut = true;
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
        try {
          resultHandle.dispose();
        } catch {
          // The session may already be dropped after a timeout.
        }
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
      if (timedOut) this.dropSession(sessionId);
    }
  }

  disposeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    // Unsettled deferreds hold live VM objects; dispose them before the
    // context so runtime teardown finds no surviving handles.
    for (const deferred of session.inflight) {
      try {
        deferred.dispose();
      } catch {
        // Best effort; teardown must proceed to free the runtime.
      }
    }
    session.inflight.clear();
    try {
      session.context.dispose();
    } finally {
      session.runtime.dispose();
    }
  }

  disposeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.disposeSession(sessionId);
    }
  }

  private async ensureSession(sessionId: string): Promise<SessionState> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    if (!this.modulePromise) this.modulePromise = this.moduleLoader();
    let module: QuickJSWASMModule;
    try {
      module = await this.modulePromise;
    } catch (error: unknown) {
      // A failed load must not poison later sessions; clear it so the next
      // call retries instead of replaying the same rejection.
      this.modulePromise = undefined;
      throw error;
    }
    const runtime = module.newRuntime();
    let context: QuickJSContext;
    try {
      context = runtime.newContext();
    } catch (error: unknown) {
      runtime.dispose();
      throw error;
    }
    // No wall-clock in the sandbox unless bridged through PTC.
    this.evalForEffect(context, 'delete globalThis.Date;');
    const session: SessionState = { runtime, context, inflight: new Set() };
    this.sessions.set(sessionId, session);
    return session;
  }

  /** Runs code for its side effects, disposing the result handles. */
  private evalForEffect(context: QuickJSContext, code: string): void {
    const scrubbed = context.evalCode(code);
    if (scrubbed.error) scrubbed.error.dispose();
    else scrubbed.value.dispose();
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
    scope: BridgeScope,
    beforeCall: () => void,
  ): void {
    if (config.ptcMode === 'unleashed') {
      this.defineToolsUnleashed(context, track, config, scope);
    } else {
      this.defineToolsGuarded(context, track, config, scope, beforeCall);
    }
  }

  private defineToolsGuarded(
    context: QuickJSContext,
    track: (handle: QuickJSHandle) => QuickJSHandle,
    config: WorkflowConfig,
    scope: BridgeScope,
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
          return this.invokePtcTool(scope, context, tool, rawArgs);
        }),
      );
      context.setProp(toolsObj, name, fn);
    }
    context.setProp(context.global, 'tools', toolsObj);
  }

  /**
   * Unleashed PTC: no call cap, and any tool name resolves — first against
   * the static allowlist (camelCase, as in guarded mode), then through the
   * host's `toolResolver`. Unresolvable names stay absent, exactly as in
   * guarded mode. The `__ptc*` bridge functions are captured by the proxy
   * closure and removed from the global scope during setup.
   */
  private defineToolsUnleashed(
    context: QuickJSContext,
    track: (handle: QuickJSHandle) => QuickJSHandle,
    config: WorkflowConfig,
    scope: BridgeScope,
  ): void {
    const listed = new Map<string, PtcTool>();
    for (const [originalName, tool] of Object.entries(config.ptc)) {
      listed.set(toCamelCase(originalName), tool);
    }
    const resolver = this.toolResolver;
    const resolve = (name: string): PtcTool | undefined =>
      listed.get(name) ?? resolver?.(name);
    const hasFn = track(
      context.newFunction('__ptcHas', (...argHandles) => {
        const name = argHandles.length > 0 ? context.dump(argHandles[0]) : undefined;
        // No boolean constructor on the context; the proxy compares to 1.
        return context.newNumber(
          typeof name === 'string' && resolve(name) !== undefined ? 1 : 0,
        );
      }),
    );
    context.setProp(context.global, '__ptcHas', hasFn);
    const callFn = track(
      context.newFunction('__ptcCall', (...argHandles) => {
        const name = argHandles.length > 0 ? context.dump(argHandles[0]) : undefined;
        const rawArgs = argHandles.length > 1 ? context.dump(argHandles[1]) : {};
        const tool = typeof name === 'string' ? resolve(name) : undefined;
        if (!tool) {
          throw new Error(`Unknown tool "${String(name)}": the resolver has no such tool.`);
        }
        return this.invokePtcTool(scope, context, tool, rawArgs);
      }),
    );
    context.setProp(context.global, '__ptcCall', callFn);
    const setup = context.evalCode(UNLEASHED_TOOLS_SETUP, 'workflow-tools');
    if (setup.error) {
      const message = formatConsoleArg(context.dump(setup.error));
      setup.error.dispose();
      throw new Error(`Cannot initialize unleashed tools: ${message}`);
    }
    setup.value.dispose();
  }

  /**
   * Invokes one PTC tool and bridges its settlement into the sandbox,
   * returning the in-sandbox promise handle. Shared by both PTC modes.
   */
  private invokePtcTool(
    scope: BridgeScope,
    context: QuickJSContext,
    tool: PtcTool,
    rawArgs: unknown,
  ): QuickJSHandle {
    const runtime = (context.runtime ?? undefined) as QuickJSRuntime | undefined;
    const args = isRecord(rawArgs) ? rawArgs : {};
    const deferred = context.newPromise();
    scope.session.inflight.add(deferred);
    Promise.resolve()
      .then(() => tool(args))
      .then(
        (native) => {
          this.settleBridge(scope, runtime, deferred, () => {
            const valueHandle = this.fromNative(context, native);
            try {
              deferred.resolve(valueHandle);
            } finally {
              valueHandle.dispose();
            }
          });
        },
        (error: unknown) => {
          this.settleBridge(scope, runtime, deferred, () => {
            const messageHandle = context.newString(errorMessage(error));
            try {
              deferred.reject(messageHandle);
            } finally {
              messageHandle.dispose();
            }
          });
        },
      );
    return deferred.handle;
  }

  /**
   * Settles one host-bridged promise. Continuations for a dropped session are
   * skipped outright, and a bridge failure rejects the deferred instead of
   * leaving it unsettled: an unsettled deferred keeps VM objects alive and
   * aborts the process at runtime teardown.
   */
  private settleBridge(
    scope: BridgeScope,
    runtime: QuickJSRuntime | undefined,
    deferred: PendingPromise,
    settle: () => void,
  ): void {
    try {
      if (this.sessions.get(scope.sessionId) !== scope.session) return;
      try {
        settle();
      } catch (error: unknown) {
        try {
          const messageHandle = scope.session.context.newString(errorMessage(error));
          try {
            deferred.reject(messageHandle);
          } finally {
            messageHandle.dispose();
          }
        } catch {
          // The context is unusable; dispose the deferred so teardown finds
          // no surviving handles. The eval then degrades to a timeout.
          try {
            deferred.dispose();
          } catch {
            // Already torn down.
          }
        }
      }
      try {
        runtime?.executePendingJobs();
      } catch {
        // Jobs can fail when the runtime was interrupted mid-flight; the pump
        // loop reports the terminal state on its next pass.
      }
    } finally {
      scope.session.inflight.delete(deferred);
    }
  }

  private defineTask(
    context: QuickJSContext,
    track: (handle: QuickJSHandle) => QuickJSHandle,
    config: WorkflowConfig,
    scope: BridgeScope,
  ): void {
    if (!config.subagents) {
      this.evalForEffect(context, 'delete globalThis.task;');
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
        scope.session.inflight.add(deferred);
        const request = { description, subagentType, model, effort };
        Promise.resolve()
          .then(() => host.run(request, dispatcher))
          .then(
            (output) => {
              this.settleBridge(scope, runtime, deferred, () => {
                const valueHandle = context.newString(output);
                try {
                  deferred.resolve(valueHandle);
                } finally {
                  valueHandle.dispose();
                }
              });
            },
            (error: unknown) => {
              this.settleBridge(scope, runtime, deferred, () => {
                const messageHandle = context.newString(errorMessage(error));
                try {
                  deferred.reject(messageHandle);
                } finally {
                  messageHandle.dispose();
                }
              });
            },
          );
        return deferred.handle;
      }),
    );
    context.setProp(context.global, 'task', fn);
  }

  private fromNative(context: QuickJSContext, native: unknown): QuickJSHandle {
    if (native === undefined) return context.undefined;
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(native);
    } catch (error: unknown) {
      throw new Error(`Cannot bridge host value into the sandbox: ${errorMessage(error)}`);
    }
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
        try {
          return { status: 'fulfilled', value: context.dump(state.value) };
        } catch (error: unknown) {
          return { status: 'rejected', message: errorMessage(error) };
        } finally {
          // A non-promise result reports the original handle (notAPromise),
          // so only a genuine promise result owns a handle that needs
          // disposing.
          if (!state.notAPromise) {
            try {
              state.value.dispose();
            } catch {
              // Best effort; the session may already be torn down.
            }
          }
        }
      }
      if (state.type === 'rejected') {
        try {
          return { status: 'rejected', message: formatConsoleArg(context.dump(state.error)) };
        } catch (error: unknown) {
          return { status: 'rejected', message: errorMessage(error) };
        } finally {
          try {
            state.error.dispose();
          } catch {
            // Best effort; the session may already be torn down.
          }
        }
      }
      if (Date.now() > deadline) return { status: 'timeout' };
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private resultText(result: unknown): string {
    if (typeof result === 'string') return result;
    if (result === undefined) return '';
    try {
      return JSON.stringify(result) ?? String(result);
    } catch {
      try {
        return String(result);
      } catch {
        return '<unserializable result>';
      }
    }
  }

  private respond(
    result: unknown,
    consoleLines: string[],
    config: WorkflowConfig,
    error?: string,
  ): ToolResponse {
    const text = this.resultText(result);
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
