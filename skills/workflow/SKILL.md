---
name: workflow
description: Run agent-authored JavaScript in a WASM-sandboxed QuickJS interpreter with persistent session state, caller-allowlisted tools.* calls, and task() subagent fan-out that surfaces as native workflow runs. Use ONLY for explicit in-loop orchestration (loops, retries, parallel batches, result synthesis). Do NOT use for one or two simple tool calls, shell commands, or filesystem edits.
---

# Workflow (QuickJS dynamic workflow)

An in-loop `eval` tool backed by WASM QuickJS. The agent writes JavaScript;
the runtime executes it and returns only the final result. Intermediate
values stay in interpreter state, not model context.

## When to use

| Need | Use |
| ---- | --- |
| One or two simple external calls | Normal tool calling |
| Loops, branches, retries, or data transforms over tools | Workflow `eval` with PTC |
| Same work across many items, verification, recursive refinement | Workflow `eval` with `task()` fan-out |
| Shell commands, installs, tests, filesystem edits | Sandbox / shell, not the interpreter |

Runs start only on an explicit `eval` call. Nothing auto-fires: effort
levels and trigger phrases never start execution by themselves.

## Capability table

| Capability | Available by default | How to expose it |
| ---------- | -------------------- | ---------------- |
| JavaScript execution | Yes | Call `eval` |
| Top-level `await` | Yes | Use promises in interpreter code |
| `console.log`, `warn`, `error` capture | Yes | Disable with `captureConsole: false` |
| Agent tools | No | Add a PTC allowlist (`ptc`) |
| Filesystem access | No | Bridge an explicit file tool through PTC |
| Network access | No | Bridge an explicit network tool through PTC |
| Wall-clock or datetime access | No | Bridge an explicit time tool through PTC |
| Shell commands, package installs, OS execution | No | Use a sandbox backend, never the interpreter |

Warning: PTC-invoked tool calls run through the interpreter bridge, not the
normal tool path, so per-call approval workflows are bypassed for calls made
from interpreter code. Keep the PTC allowlist narrow: never bridge broad,
mutating, or spending tools unless that behavior is intentional.

## Unleashed mode

Guarded mode (default) exposes exactly the static allowlist and enforces
`maxPtcCalls`. Unleashed mode (`ptcMode: "unleashed"`) lifts both:

- No call cap: `maxPtcCalls` is ignored.
- Open resolution: any `tools.*` name resolves — first against the static
  allowlist, then through the host's `toolResolver`. Names the resolver
  cannot resolve stay absent, exactly as in guarded mode.

Unleashed mode does not lift sandbox limits (memory, stack, timeout) or
result truncation — only the PTC restrictions.

Warning: unleashed mode plus a broad resolver gives agent-authored code the
widest tool path the host offers, still with per-call approvals bypassed.
Use it only for trusted loops where that breadth is intentional, and prefer
a resolver that exposes read-only tools unless mutation is the point.

## PTC example

```js
const topics = ["retrieval", "memory"];
const results = await Promise.all(
  topics.map((topic) => tools.webSearch({ query: topic })),
);
results.join("\n\n");
```

Only allowlisted tools exist under `tools.*`, converted to camelCase
(`web_search` becomes `tools.webSearch`). Calls beyond `maxPtcCalls` fail
the `eval` without invoking anything further.

## task() fan-out example

```js
const reviews = await Promise.all(
  ["src/auth.ts", "src/routes/api.ts"].map((path) =>
    task({
      description: `Review ${path}`,
      subagentType: "reviewer",
      model: "muse-glimmer",
      effort: "ultra",
    }),
  ),
);
reviews.join("\n\n");
```

Each dispatch runs as a native workflow run: visible in `/workflows` with
live progress, stop/restart/cancel propagation, and one final result.
Omitted `model`/`effort` fall back to the caller map for that subagent type.

## Save and reuse

Name a useful script plus its config (PTC names, PTC mode, subagent map,
limits) with saveWorkflow under `.omm/workflows/`; list, re-run, or delete
it later. A re-run replays the saved mode and fan-out against
caller-supplied tool implementations, re-supplying the unleashed resolver
when the saved mode needs one.
