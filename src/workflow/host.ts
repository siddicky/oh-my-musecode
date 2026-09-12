/**
 * Workflow host adapter: the seam between interpreter `task()` dispatches and
 * a native Workflow UI.
 *
 * Every dispatch becomes a run with started/progress/completed lifecycle
 * events, which is what a `/workflows` view consumes as live progress —
 * where the install provides one. PTC tool calls likewise emit
 * started/completed rows in their own `ptc-N` id namespace, discriminated
 * by `kind: "ptc"` so adapters can project tool activity next to run lists.
 * Native workflow availability is gated by
 * muse's per-install feature config (`workflow_tool`; verified true on Muse
 * 1.1.1-R2514.1 aarch64, with `workflow_api_v2_rollout` still false), and
 * installs compiled without the script engine say so at launch. This host
 * is the library-side seam regardless: hosts without the native plane
 * surface this event stream through their own adapters. Host
 * cancel and restart signals propagate into the running dispatch: cancel
 * terminates it, restart re-executes the dispatcher and emits a second
 * started event for the same run id.
 */

import type {
  SubagentDispatcher,
  WorkflowEvent,
  WorkflowEventType,
  WorkflowPtcEvent,
  WorkflowPtcEventType,
} from "./types.js";

export class WorkflowCancelledError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Workflow run ${runId} was cancelled.`);
    this.name = "WorkflowCancelledError";
    this.runId = runId;
  }
}

interface RunState {
  controller: AbortController;
}

type AttemptOutcome =
  | { status: "ok"; output: string }
  | { status: "cancelled" }
  | { status: "restart" }
  | { status: "failed"; error: unknown };

export interface RunRequest {
  description: string;
  subagentType: string;
  model: string;
  effort: string;
}

export class WorkflowHost {
  private nextId = 0;
  private nextPtcId = 0;
  private readonly runs = new Map<string, RunState>();
  readonly events: WorkflowEvent[] = [];
  private readonly listener: ((event: WorkflowEvent) => void) | undefined;

  constructor(listener?: (event: WorkflowEvent) => void) {
    this.listener = listener;
  }

  private emit(
    type: WorkflowEventType,
    runId: string,
    attempt: number,
    request: RunRequest,
    extra?: { outputLength?: number; error?: string },
  ): void {
    const event: WorkflowEvent = {
      kind: "subagent",
      type,
      runId,
      attempt,
      subagentType: request.subagentType,
      description: request.description,
      model: request.model,
      effort: request.effort,
      ...extra,
    };
    this.events.push(event);
    try {
      this.listener?.(event);
    } catch {
      // Listener errors must not break the dispatch lifecycle or mask the
      // dispatcher outcome.
    }
  }

  /**
   * Runs one dispatch to completion, emitting lifecycle events. A host
   * restart aborts the current attempt and re-runs the dispatcher; a host
   * cancel aborts it with a WorkflowCancelledError.
   */
  async run(
    request: RunRequest,
    dispatcher: SubagentDispatcher,
  ): Promise<string> {
    const runId = `run-${++this.nextId}`;
    const state: RunState = { controller: new AbortController() };
    this.runs.set(runId, state);
    try {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        this.emit("started", runId, attempt, request);
        const outcome = await this.raceAttempt(
          state.controller.signal,
          (signal) =>
            dispatcher({
              ...request,
              runId,
              attempt,
              signal,
            }),
        );
        switch (outcome.status) {
          case "restart":
            continue;
          case "cancelled":
            this.emit("cancelled", runId, attempt, request);
            throw new WorkflowCancelledError(runId);
          case "failed":
            throw outcome.error;
          case "ok":
            this.emit("progress", runId, attempt, request, {
              outputLength: outcome.output.length,
            });
            this.emit("completed", runId, attempt, request, {
              outputLength: outcome.output.length,
            });
            return outcome.output;
        }
      }
    } finally {
      this.runs.delete(runId);
    }
  }

  /**
   * Runs one PTC tool call, emitting started/completed UI rows around it. A
   * throwing tool emits no terminal event — mirroring a failed subagent
   * dispatch — and the error propagates to the caller. Tool-call ids are
   * never runs, so cancel/restart do not apply to them.
   */
  async runPtc(
    tool: string,
    invoke: () => Promise<unknown>,
  ): Promise<unknown> {
    const toolCallId = `ptc-${++this.nextPtcId}`;
    this.emitPtc("started", toolCallId, tool);
    const output = await invoke();
    let outputLength: number | undefined;
    try {
      outputLength = JSON.stringify(output)?.length;
    } catch {
      outputLength = undefined;
    }
    this.emitPtc("completed", toolCallId, tool, outputLength);
    return output;
  }

  private emitPtc(
    type: WorkflowPtcEventType,
    toolCallId: string,
    tool: string,
    outputLength?: number,
  ): void {
    const event: WorkflowPtcEvent = { kind: "ptc", type, toolCallId, tool };
    if (outputLength !== undefined) event.outputLength = outputLength;
    this.events.push(event);
    try {
      this.listener?.(event);
    } catch {
      // Listener errors must not break the tool-call lifecycle or mask the
      // tool outcome.
    }
  }

  /** Terminates the running attempt for `runId`. */
  cancel(runId: string): boolean {
    const state = this.runs.get(runId);
    if (!state) return false;
    state.controller.abort("cancelled");
    return true;
  }

  /** Aborts the current attempt and re-runs the dispatcher under the same run id. */
  restart(runId: string): boolean {
    const state = this.runs.get(runId);
    if (!state) return false;
    state.controller.abort("restart");
    state.controller = new AbortController();
    return true;
  }

  private raceAttempt(
    signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<string>,
  ): Promise<AttemptOutcome> {
    if (signal.aborted) {
      return Promise.resolve({ status: this.abortStatus(signal.reason) });
    }
    // Invoke outside the Promise executor so a synchronous dispatcher throw
    // routes through the failed path instead of rejecting raceAttempt from
    // inside the executor.
    let pending: Promise<string>;
    try {
      pending = work(signal);
    } catch (error: unknown) {
      return Promise.resolve({ status: "failed", error });
    }
    return new Promise((resolve) => {
      const onAbort = (): void => {
        resolve({ status: this.abortStatus(signal.reason) });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (output) => {
          signal.removeEventListener("abort", onAbort);
          resolve({ status: "ok", output });
        },
        (error: unknown) => {
          // A dispatcher failure is terminal for this attempt: the original
          // error propagates so the interpreter reports it, not a cancellation.
          signal.removeEventListener("abort", onAbort);
          resolve({ status: "failed", error });
        },
      );
    });
  }

  private abortStatus(reason: unknown): "cancelled" | "restart" {
    // Only cancel() and restart() abort this signal, but default unknown
    // reasons to cancelled so a stray abort can never silently re-loop as a
    // restart.
    return reason === "restart" ? "restart" : "cancelled";
  }
}
