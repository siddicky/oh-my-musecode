---
name: cancel
description: End any active pipeline stage (deep-interview, deep-dive, trace, ralplan, ralph, team) and clean up .omm/ state left running or in progress. Use ONLY when the user explicitly asks to cancel, stop, or abandon current work, or invokes /cancel. Do NOT use to pause and resume later (leave in-progress state alone if the user just wants a break), and do not use it to undo already-committed code changes — this skill stops orchestration state, it does not revert files.
---

# Cancel

Stop whatever pipeline stage is active and leave `.omm/` state in a clean,
honest, resumable-or-discardable condition. Explicit invocation only — like
every skill here, nothing auto-cancels on your behalf; the user has to ask.

## Scope

This skill ends orchestration state. It does not:

- Revert code changes already made to the working tree. If the user also
  wants that, they need to say so separately (`git` operations are a
  distinct, more destructive action and should never be inferred from a
  bare "cancel").
- Kill a task the user actually wants paused rather than abandoned. If the
  request is genuinely "pause, I'll come back to this," leave the state
  files as they are — this skill is for "stop, and I mean stop," not for a
  checkpoint.

If it is unclear which the user means, ask before deleting anything —
cleanup here is one-directional.

## What "active" means

Check for state that implies an in-flight stage:

- `.omm/specs/*.md` with no terminal approval marker (an interview left
  mid-round or a spec left unapproved).
- `.omm/state/trace-*.md` for a trace that never converged.
- `.omm/state/prd.json` with any story `status` other than `"done"` or
  `"blocked"`.
- Any `subagent_spawn` children still running from a `team` or `ralph` run
  in this session — check with `subagent_status` across tracked ids.

## Steps

1. **Cancel live subagents first.** For every tracked subagent id from an
   active `team` or `ralph` run that is still running, call
   `subagent_cancel` and wait for terminal cancellation
   (`subagent_wait`/`subagent_status`) before touching files — do not leave
   a subagent writing into a worktree you are about to declare abandoned.
2. **Mark state, don't just delete it.** For each in-flight artifact found
   above, decide with the user (or from their instruction) whether to:
   - **Discard**: delete the file/entry. Only do this for state the user
     explicitly wants gone.
   - **Archive**: move it under `.omm/logs/cancelled/<timestamp>-<name>` so
     the evidence of what was attempted survives even though the run did
     not complete. Prefer this default over silent deletion — an
     abandoned run is still useful history.
3. **Leave completed work alone.** Stories already `"done"` in `prd.json`,
   approved specs, and merged `team` results are not part of what gets
   cleaned up — cancel affects the active/pending state, not history that
   already succeeded.
4. **Report exactly what changed.** List every file archived or deleted and
   every subagent cancelled. Do not report "cancelled" if some tracked
   subagent could not be confirmed terminal — say so and flag it instead of
   claiming a clean stop.

## Worktrees

If a `team` or `ralph` run left worktrees under muse's worktree area from
`worktree_isolation`, note their existence in the report so the user can
decide whether to keep or discard them — this skill does not assume
authority to delete a worktree that might contain unmerged, wanted work.

## Handoff

Cancel is terminal by design — it does not chain into anything. After
reporting, stop. If the user wants to restart the same effort, they invoke
the relevant skill again explicitly; cancel does not offer to do that for
them.
