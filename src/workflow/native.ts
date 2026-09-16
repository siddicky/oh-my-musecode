/**
 * Native muse workflow extension generators.
 *
 * Compiles this repo's two workflow-runtime bridges — PTC (programmatic tool
 * calling) and `task()` dynamic-subagent fan-out — into scripts for muse's
 * NATIVE Workflow tool, so the same capability model runs on the host's own
 * engine instead of (or alongside) the embedded QuickJS runtime.
 *
 * Supported build: Muse Code 1.3.0-R3057.1 (aarch64-apple-darwin), whose
 * feature config reports `plugins: true`, `workflow_tool: true`, and
 * `workflow_api_v2_rollout: false` (captured in docs/live-probes-1.3.0.md).
 * The contract below was verified against
 * a real run on the 1.1.1 build; re-verification on 1.3.0 runs with the
 * schema/headless probes (see US-006):
 *
 * - The native `workflow` tool takes `{ script }`; the script is a JavaScript
 *   module `export default async function workflow(host) { ... }` (a
 *   top-level-await body calling the bare globals is also accepted).
 * - Host API v1 exposes `agent`, `parallel`, `pipeline` (plus `phase`, `log`,
 *   `args`, `budget`); `host.*` names are the same functions. Every script
 *   must call `agent`, `pipeline`, or `parallel` at least once and return a
 *   JSON-serializable terminal value.
 * - Requests take `{ input, agentType?, schema?, isolation?, label? }`;
 *   `input` is a required non-empty string. V1 requests carry no
 *   model/effort override — launch defaults and the user's token budget
 *   govern children (`budget` reports them; a typical child spends 30k-150k
 *   tokens, the observed policy caps children at 8 per parallel batch with a
 *   1000-call lifetime cap).
 * - For multiple child results the contract prescribes one synthesis
 *   `agent` child and a returned object carrying `synthesis.ref`/`synthesis.text`.
 * - Under `run.workflow_trigger_mode: "explicit"` (this machine's setting)
 *   the tool fires only on the user's explicit ask.
 *
 * Native V1 scripts cannot call host tools directly — there is no in-script
 * `tools.*` bridge — so a PTC call maps to one tightly-instructed child agent
 * that performs exactly the requested call and returns its raw result.
 * Admission is enforced at generation time: un-allowlisted or cap-exceeded
 * calls are never emitted into the script and come back as explicit error
 * entries, never silent drops.
 */

/** Host API version these generators target. */
export const NATIVE_HOST_API_VERSION = "v1";

/** Observed native policy: max children per `parallel` batch. */
export const NATIVE_PARALLEL_CHILD_LIMIT = 8;

/** One programmatic tool call to perform inside a native workflow. */
export interface NativePtcRequest {
  /** Original tool name, as it appears to the host (e.g. `web_search`). */
  tool: string;
  /** Verbatim call arguments. */
  args: Record<string, unknown>;
}

/** One dynamic-subagent dispatch, mirroring `TaskCall`. */
export interface NativeFanoutTask {
  /** The child's objective; must be non-empty. */
  description: string;
  /** Optional persona/SOUL text prepended to the objective (this repo's persona model). */
  personaText?: string;
  /** Display label for the child run. */
  label?: string;
}

export interface NativeScriptOptions {
  /**
   * Tool names allowed in the emitted script. Fail-closed: an empty or
   * omitted list refuses every call. A deliberate open batch is still
   * explicit — pass the tools you intend to call, e.g.
   * `allowlist: [...new Set(calls.map((c) => c.tool))]`.
   */
  allowlist?: readonly string[];
  /** Optional call cap; null (default) leaves the batch uncapped. */
  maxCalls?: number | null;
  /** Synthesis child objective prefix for multi-child scripts. */
  synthesisPrompt?: string;
}

export interface NativeScript {
  /** The `script` string to pass to the native `workflow` tool. */
  script: string;
  /** Generation-time decisions the caller should surface (refusals, batch splits). */
  notes: string[];
}

interface ChildOutcome {
  label: string;
  ref?: string;
  text?: string;
  error?: string;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function childInput(
  personaText: string | undefined,
  objective: string,
): string {
  const persona = personaText?.trim();
  return persona ? `${persona}\n\n---\n\n${objective}` : objective;
}

function emitChildrenArray(
  entries: Array<{ input: string; label: string }>,
): string {
  const lines = entries.map(
    (e) => `    { input: ${json(e.input)}, label: ${json(e.label)} },`,
  );
  return `[\n${lines.join("\n")}\n  ]`;
}

function emitOutcomeMapping(): string {
  return "results.map((r, i) => (r ? { label: labels[i], ref: r.ref, text: r.text } : { label: labels[i], error: 'no result' }))";
}

/** JS expression: static prefix, separator, then the runtime `body` string. */
function emitSynthesisInput(prefix: string): string {
  return `${json(`${prefix}\n\n---\n\nChild results, in order:\n`)} + body`;
}

type ChildEntries = Array<{ input: string; label: string }>;

function chunkChildren(entries: ChildEntries): {
  batches: ChildEntries[];
  notes: string[];
} {
  const batches: ChildEntries[] = [];
  for (let i = 0; i < entries.length; i += NATIVE_PARALLEL_CHILD_LIMIT) {
    batches.push(entries.slice(i, i + NATIVE_PARALLEL_CHILD_LIMIT));
  }
  const notes =
    batches.length > 1
      ? [
          `${entries.length} children split into ${batches.length} sequential batches of <= ${NATIVE_PARALLEL_CHILD_LIMIT} (observed native childLimit)`,
        ]
      : [];
  return { batches, notes };
}

function emitParallelBatches(
  varPrefix: string,
  batches: ChildEntries[],
): { lines: string[]; resultsExpr: string } {
  const lines = batches.map(
    (batch, i) =>
      `  const ${varPrefix}${i + 1} = await host.parallel(${emitChildrenArray(batch)});`,
  );
  const resultsExpr = `[].concat(${batches.map((_, i) => `${varPrefix}${i + 1}`).join(", ")})`;
  return { lines, resultsExpr };
}

/**
 * PTC batch → one native workflow script. Each allowlisted call becomes one
 * child agent instructed to perform exactly that call and return its raw
 * result; multiple calls fan out via `parallel` plus a synthesis child per
 * the contract. Calls outside `allowlist` or beyond `maxCalls` are never
 * emitted — both surface as explicit error entries, never silent drops.
 *
 * There is deliberately no "unleashed" mode here. Unlike the QuickJS
 * runtime — where the interpreter enforces a host-configured allowlist
 * against agent-authored code at run time — this generator receives the
 * allowlist and the calls from the same caller at the same moment, so an
 * open mode would only skip a checklist the caller wrote themselves. If
 * muse ever ships an in-script tools bridge (a real runtime boundary to
 * lift), revisit.
 */
export function buildNativePtcScript(
  requests: readonly NativePtcRequest[],
  options: NativeScriptOptions = {},
): NativeScript {
  const maxCalls = options.maxCalls ?? null;
  const allowlist = new Set(options.allowlist ?? []);
  const notes: string[] = [];

  const admitted: NativePtcRequest[] = [];
  const refusals: ChildOutcome[] = [];
  let callsUsed = 0;

  for (const request of requests) {
    if (!allowlist.has(request.tool)) {
      refusals.push({ label: request.tool, error: "not allowlisted" });
      continue;
    }
    if (maxCalls !== null && callsUsed >= maxCalls) {
      refusals.push({ label: request.tool, error: "maxPtcCalls exceeded" });
      continue;
    }
    admitted.push(request);
    callsUsed += 1;
  }
  if (refusals.length > 0) {
    notes.push(
      `${refusals.length} call(s) refused at generation time: ${refusals
        .map((r) => `${r.label} (${r.error})`)
        .join(", ")}`,
    );
  }
  if (admitted.length === 0) {
    throw new Error(
      "native PTC script: no admitted calls (empty request set or all refused)",
    );
  }

  const entries = admitted.map((request, index) => ({
    label: `${request.tool}-${index + 1}`,
    input: [
      `Call the host tool named ${JSON.stringify(request.tool)} with exactly these arguments and nothing else:`,
      json(request.args),
      "Perform only this call. Return the tool call result verbatim as your final answer; if the call fails, return the error text.",
    ].join("\n"),
  }));

  const labels = entries.map((e) => e.label);
  const prefix =
    options.synthesisPrompt ??
    "Join the tool results below into one JSON object mapping each label to its result text. Do not editorialize; preserve wording.";

  let script: string;
  if (admitted.length === 1) {
    const only = entries[0];
    script = [
      "export default async function workflow(host) {",
      `  const result = await host.agent({ input: ${json(only.input)}, label: ${json(only.label)} });`,
      "  if (!result) {",
      `    return { status: 'error', refusals: ${json(refusals)}, children: [{ label: ${json(only.label)}, error: 'no result' }] };`,
      "  }",
      `  return { status: 'ok', ref: result.ref, text: result.text, refusals: ${json(refusals)} };`,
      "}",
      "",
    ].join("\n");
  } else {
    const { batches, notes: batchNotes } = chunkChildren(entries);
    notes.push(...batchNotes);
    const { lines: batchLines, resultsExpr } = emitParallelBatches(
      "batch",
      batches,
    );
    script = [
      "export default async function workflow(host) {",
      `  const labels = ${json(labels)};`,
      ...batchLines,
      `  const results = ${resultsExpr};`,
      `  const children = ${emitOutcomeMapping()};`,
      "  const body = children.map((c) => c.label + ': ' + (c.text ?? c.error ?? '')).join('\\n\\n');",
      `  const synthesis = await host.agent({ input: ${emitSynthesisInput(prefix)} });`,
      "  if (!synthesis) {",
      `    return { status: 'error', children, refusals: ${json(refusals)} };`,
      "  }",
      `  return { status: 'ok', synthesis: { ref: synthesis.ref, text: synthesis.text }, children, refusals: ${json(refusals)} };`,
      "}",
      "",
    ].join("\n");
  }
  return { script, notes };
}

/**
 * Dynamic-subagent fan-out → one native workflow script. Tasks fan out via
 * `parallel` (auto-batched to the observed 8-child policy limit), followed
 * by the contract-mandated synthesis child. V1 requests carry no
 * model/effort override, so callers embedding this repo's routing metadata
 * should fold it into `personaText`/`description` themselves.
 */
export function buildNativeFanoutScript(
  tasks: readonly NativeFanoutTask[],
  options: NativeScriptOptions = {},
): NativeScript {
  if (tasks.length === 0) {
    throw new Error("native fan-out script: no tasks given");
  }
  const notes: string[] = [];

  const entries = tasks.map((task, index) => {
    const input = childInput(task.personaText, task.description);
    if (input.trim().length === 0) {
      throw new Error(
        `native fan-out script: task ${index + 1} has empty input`,
      );
    }
    return { input, label: task.label ?? `child-${index + 1}` };
  });

  const labels = entries.map((e) => e.label);
  const { batches, notes: batchNotes } = chunkChildren(entries);
  notes.push(...batchNotes);

  const prefix =
    options.synthesisPrompt ??
    "Synthesize the child results below into one coherent answer. Preserve each child label as a section heading.";

  const { lines: batchBlocks, resultsExpr } = emitParallelBatches(
    "batch",
    batches,
  );

  const script = [
    "export default async function workflow(host) {",
    `  const labels = ${json(labels)};`,
    ...batchBlocks,
    `  const results = ${resultsExpr};`,
    `  const children = ${emitOutcomeMapping()};`,
    "  const body = children.map((c) => c.label + ': ' + (c.text ?? c.error ?? '')).join('\\n\\n');",
    `  const synthesis = await host.agent({ input: ${emitSynthesisInput(prefix)} });`,
    "  if (!synthesis) {",
    "    return { status: 'error', children };",
    "  }",
    "  return { status: 'ok', synthesis: { ref: synthesis.ref, text: synthesis.text }, children };",
    "}",
    "",
  ].join("\n");
  return { script, notes };
}
