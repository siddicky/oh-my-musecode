---
name: team
description: Run N coordinated persona subagents in parallel against a shared task list, each isolated in its own worktree, for work that splits cleanly into independent units. Use ONLY when explicitly invoked (/team) for genuinely parallelizable work — several independent files, stories, or investigations with no shared-state conflicts. Do NOT use for a single sequential task, for work with heavy cross-file coupling that would fight worktree isolation, or as an automatic response to "this is a big task."
---

# Team

Coordinate multiple persona subagents working in parallel on a shared task
list, each isolated in its own worktree so simultaneous writers do not
collide on the same files.

Explicit invocation only. Nothing infers that a task "is big enough" to
warrant a team on its own — you decide that and invoke `/team`, or another
skill's prose (such as `ralph`, for a PRD with an explicit parallel group)
tells the user to.

## When to use this

Use it when the task list has real independence: separate stories, separate
files or modules, separate investigations that do not need to see each
other's intermediate state. Do not use it when tasks are tightly coupled —
sequential work through one context (or a single `ralph` loop) is both
simpler and avoids merge friction. Do not use it for a task list of one.

## Building the task list

Source the task list from, in order of preference:
1. An explicit list the user gives in the invocation.
2. `.omm/state/prd.json`, if it declares an explicit parallel group (see
   `ralph`) — use exactly that group, not the whole PRD.
3. A list you derive directly from the request, stated back to the user
   before spawning anything if it required real judgment to split.

Each task needs: an id, a scope narrow enough for one persona to own without
touching another task's files, and a definition of done.

## Spawning

For each task, choose the persona that fits its shape (`executor` for
implementation, `test-engineer` for test work, `writer` for docs,
`debugger` for isolated bug fixes, etc.) and:

```
subagent_spawn(role, objective, worktree_isolation: true)
```

Always set `worktree_isolation: true` for team members that write files —
this is the mechanism that keeps parallel writers from stepping on each
other; without it, concurrent edits to overlapping files are a real risk,
not a hypothetical one. Read-only investigation tasks may skip isolation if
they touch nothing.

Track every spawned id against its task. Do not spawn more than the
session's concurrent-child limit at once (muse caps concurrent subagent
children); queue remaining tasks and spawn the next as a slot frees up
rather than firing them all and hoping.

## Coordination

- Poll with `subagent_status` / `subagent_wait` rather than assuming
  completion order matches spawn order.
- If one task's output changes what another in-flight task should do, use
  `subagent_send_message` to update it rather than letting it finish on a
  stale premise.
- If a task is no longer needed (superseded by another's findings, or the
  user narrows scope mid-run), `subagent_cancel` it explicitly rather than
  leaving it to finish pointless work.
- Read every terminal result with `subagent_read_result` before reporting —
  a `subagent_wait` timeout is not a terminal state; keep waiting or check
  status again rather than treating a timeout as failure.

## Merging results

Worktree isolation means each task's changes live in its own worktree until
merged. Review each task's diff before merging — do not merge blind because
the subagent reported success. Merge in an order that respects real
dependencies between tasks (a task that renamed a shared interface merges
before tasks that consume it, even if it finished later). Surface merge
conflicts to the user rather than silently picking a resolution when the
conflict touches logic, not just formatting.

## Completion report

Report per task: id, persona used, terminal status, whether its worktree was
merged, and any conflicts or cancellations. If any task is blocked or
failed, list it prominently rather than only reporting the successes.

## Handoff

Team has no fixed successor — what comes next depends on what the parallel
work was for. If it was a `ralph` parallel group, say so and return control
to the ralph loop's per-story verification. Otherwise, state completion and
let the user decide the next step; do not chain into another skill on your
own initiative.
