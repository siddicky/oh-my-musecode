/**
 * Workflow host adapter: the seam between interpreter `task()` dispatches and
 * the native Workflow UI.
 *
 * Every dispatch becomes a run with started/progress/completed lifecycle
 * events, which is what surfaces in `/workflows` as live progress. Host
 * cancel and restart signals propagate into the running dispatch: cancel
 * terminates it, restart re-executes the dispatcher and emits a second
 * started event for the same run id.
 */

import type { SubagentDispatcher, WorkflowEvent, WorkflowEventType } from './types.js';

export class WorkflowCancelledError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`Workflow run ${runId} was cancelled.`);
    this.name = 'WorkflowCancelledError';
    this.runId = runId;
  }
}

interface RunState {
  controller: AbortController;
}

type AttemptOutcome =
  | { status: 'ok'; output: string }
  | { status: 'cancelled' }
  | { status: 'restart' }
  | { status: 'failed'; error: unknown };

export interface RunRequest {
  description: string;
  subagentType: string;
  model: string;
  effort: string;
}

export class WorkflowHost {
  private nextId = 0;
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
  async run(request: RunRequest, dispatcher: SubagentDispatcher): Promise<string> {
    const runId = `run-${++this.nextId}`;
    const state: RunState = { controller: new AbortController() };
    this.runs.set(runId, state);
    try {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        this.emit('started', runId, attempt, request);
        const outcome = await this.raceAttempt(state.controller.signal, (signal) =>
          dispatcher({
            ...request,
            runId,
            attempt,
            signal,
          }),
        );
        switch (outcome.status) {
          case 'restart':
            continue;
          case 'cancelled':
            this.emit('cancelled', runId, attempt, request);
            throw new WorkflowCancelledError(runId);
          case 'failed':
            throw outcome.error;
          case 'ok':
            this.emit('progress', runId, attempt, request, {
              outputLength: outcome.output.length,
            });
            this.emit('completed', runId, attempt, request, {
              outputLength: outcome.output.length,
            });
            return outcome.output;
        }
      }
    } finally {
      this.runs.delete(runId);
    }
  }

  /** Terminates the running attempt for `runId`. */
  cancel(runId: string): boolean {
    const state = this.runs.get(runId);
    if (!state) return false;
    state.controller.abort('cancelled');
    return true;
  }

  /** Aborts the current attempt and re-runs the dispatcher under the same run id. */
  restart(runId: string): boolean {
    const state = this.runs.get(runId);
    if (!state) return false;
    state.controller.abort('restart');
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
      return Promise.resolve({ status: 'failed', error });
    }
    return new Promise((resolve) => {
      const onAbort = (): void => {
        resolve({ status: this.abortStatus(signal.reason) });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (output) => {
          signal.removeEventListener('abort', onAbort);
          resolve({ status: 'ok', output });
        },
        (error: unknown) => {
          // A dispatcher failure is terminal for this attempt: the original
          // error propagates so the interpreter reports it, not a cancellation.
          signal.removeEventListener('abort', onAbort);
          resolve({ status: 'failed', error });
        },
      );
    });
  }

  private abortStatus(reason: unknown): 'cancelled' | 'restart' {
    // Only cancel() and restart() abort this signal, but default unknown
    // reasons to cancelled so a stray abort can never silently re-loop as a
    // restart.
    return reason === 'restart' ? 'restart' : 'cancelled';
  }
}
