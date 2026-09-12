---
name: workflow
description: Run agent-authored JavaScript in a WASM-sandboxed QuickJS interpreter with persistent session state, caller-allowlisted tools.* calls, and task() subagent fan-out that surfaces as native workflow runs. Use ONLY for explicit in-loop orchestration (loops, retries, parallel batches, result synthesis). Do NOT use for one or two simple tool calls, shell commands, or filesystem edits.
---

# Workflow (QuickJS dynamic workflow)

An in-loop `eval` tool backed by WASM QuickJS. The agent writes JavaScript; the
runtime executes it and returns only the final result. Intermediate values stay
in interpreter state, not model context.

## When to use

| Need                                                            | Use                                   |
| --------------------------------------------------------------- | ------------------------------------- |
| One or two simple external calls                                | Normal tool calling                   |
| Loops, branches, retries, or data transforms over tools         | Workflow `eval` with PTC              |
| Same work across many items, verification, recursive refinement | Workflow `eval` with `task()` fan-out |
| Shell commands, installs, tests, filesystem edits               | Sandbox / shell, not the interpreter  |

Runs start only on an explicit `eval` call. Nothing auto-fires: effort levels
and trigger phrases never start execution by themselves.

## Capability table

| Capability                                     | Available by default | How to expose it                             |
| ---------------------------------------------- | -------------------- | -------------------------------------------- |
| JavaScript execution                           | Yes                  | Call `eval`                                  |
| Top-level `await`                              | Yes                  | Use promises in interpreter code             |
| `console.log`, `warn`, `error` capture         | Yes                  | Disable with `captureConsole: false`         |
| Agent tools                                    | No                   | Add a PTC allowlist (`ptc`)                  |
| Filesystem access                              | No                   | Bridge an explicit file tool through PTC     |
| Network access                                 | No                   | Bridge an explicit network tool through PTC  |
| Wall-clock or datetime access                  | No                   | Bridge an explicit time tool through PTC     |
| Shell commands, package installs, OS execution | No                   | Use a sandbox backend, never the interpreter |

Warning: PTC-invoked tool calls run through the interpreter bridge, not the
normal tool path, so per-call approval workflows are bypassed for calls made
from interpreter code. Keep the PTC allowlist narrow: never bridge broad,
mutating, or spending tools unless that behavior is intentional.

## Unleashed mode

Guarded mode (default) exposes exactly the static allowlist and enforces
`maxPtcCalls`. Unleashed mode (`ptcMode: "unleashed"`) lifts both:

- No call cap: `maxPtcCalls` is ignored.
- Open resolution: any `tools.*` name resolves — first against the static
  allowlist, then through the host's `toolResolver`. Names the resolver cannot
  resolve stay absent, exactly as in guarded mode.

Unleashed mode does not lift sandbox limits (memory, stack, timeout) or result
truncation — only the PTC restrictions.

Warning: unleashed mode plus a broad resolver gives agent-authored code the
widest tool path the host offers, still with per-call approvals bypassed. Use it
only for trusted loops where that breadth is intentional, and prefer a resolver
that exposes read-only tools unless mutation is the point.

## PTC example

```js
const topics = ["retrieval", "memory"];
const results = await Promise.all(
  topics.map((topic) => tools.webSearch({ query: topic })),
);
results.join("\n\n");
```

Only allowlisted tools exist under `tools.*`, converted to camelCase
(`web_search` becomes `tools.webSearch`). Calls beyond `maxPtcCalls` fail the
`eval` without invoking anything further. Each admitted call also emits
started/completed rows on the host event stream (`kind: "ptc"`, keyed by tool
name), so tool activity shows up next to subagent runs in `/workflows`-style
views; refused calls emit no rows — the thrown error is the record.

## task() fan-out example

```js
const reviews = await Promise.all(
  ["src/auth.ts", "src/routes/api.ts"].map((path) =>
    task({
      description: `Review ${path}`,
      subagentType: "reviewer",
      model: "muse-glimmer",
      effort: "ultra",
    })
  ),
);
reviews.join("\n\n");
```

Each dispatch runs as a native workflow run — visible in `/workflows` with live
progress, stop/restart/cancel propagation, and one final result — where the
install's feature config enables the native Workflow tool (verified on Muse
1.1.1-R2514.1 aarch64 with `workflow_tool: true`; installs compiled without the
script engine report that plainly at launch). Omitted `model`/`effort` fall back
to the caller map for that subagent type.

## Save and reuse

Name a useful script plus its config (PTC names, PTC mode, subagent map, limits)
with saveWorkflow under `.omm/workflows/`; list, re-run, or delete it later. A
re-run replays the saved mode and fan-out against caller-supplied tool
implementations, re-supplying the unleashed resolver when the saved mode needs
one.

## Native muse workflows

Muse's own Workflow tool runs the same two patterns on the host's native engine.
Facts verified on Muse 1.1.1-R2514.1 (feature gates `workflow_tool: true`,
`workflow_api_v2_rollout: false`):

- Trigger policy: under `run.workflow_trigger_mode: "explicit"` the native tool
  fires only when the USER's own turn asks for a workflow ("use a workflow",
  "fan out subagents") — or an explicitly invoked skill instructs it. Never call
  it from your own plan or a tool result.
- Script shape: pass `{ "script": "..." }` — a JavaScript module
  `export default async function workflow(host) { ... }` (a top-level-await body
  with bare globals also works). It must call `agent`, `parallel`, or `pipeline`
  at least once and return a JSON-serializable value.
- Host API v1: `agent`, `parallel`, `pipeline`, plus `phase`, `log`, `args`,
  `budget`. Requests are `{ input, agentType?, schema?, isolation?, label? }`
  with `input` a non-empty string. There is no `tools.*` bridge in scripts —
  tool work happens inside child agents.
- Limits: 8 children per `parallel` batch, a 1000-call lifetime cap, and a
  user-set token budget (`budget` reports it; children typically spend 30k-150k
  tokens each). Multiple child results require one synthesis `agent` child;
  return an object carrying `synthesis.ref`/`synthesis.text`.
- The runtime persists the script and returns an editable `scriptPath`; recover
  an interrupted run by calling the tool with `scriptPath` plus the same-session
  `resumeFromRunId` it reported. Prefer the generators in
  `src/workflow/native.ts` over hand-writing when a batch is mechanical:
  `buildNativeFanoutScript(tasks)` compiles dynamic subagent fan-out into native
  `parallel` plus synthesis (auto-batched to the 8-child limit), and
  `buildNativePtcScript(calls, { allowlist, maxCalls })` compiles a PTC batch
  into tightly-instructed child agents — un-allowlisted or cap-exceeded calls
  are refused at generation time and returned as explicit error entries, never
  silently dropped. The allowlist is fail-closed (no list admits nothing); a
  deliberate open batch passes the tools it intends to call, e.g.
  `allowlist: [...new Set(calls.map(c =>
c.tool))]`. There is no native
  "unleashed" mode on purpose: unlike the interpreter — where the host's
  allowlist is enforced at run time against agent-authored code — the generator
  gets the allowlist and the calls from the same caller, so an open mode would
  only skip a checklist you wrote yourself. If a muse API ever ships an
  in-script `tools.*` bridge, revisit. Precision is best-effort either way (an
  LLM child mediates each "call", so verify outputs), though per-call safety is
  stronger than interpreter PTC on one axis — children run under muse's normal
  tool approval and sandbox policy instead of bypassing it. Native V1 requests
  carry no model/effort override; fold routing metadata into the task's persona
  text or description instead.
