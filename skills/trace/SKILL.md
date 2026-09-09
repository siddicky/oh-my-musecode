---
name: trace
description: Investigate a specific observed problem (a bug, a regression, an unexpected behavior) by running competing tracer hypotheses in parallel and converging on the best-evidenced explanation. Use ONLY when the user explicitly asks to trace, diagnose, or root-cause a concrete symptom, or invokes /trace. Do NOT use for vague goal-shaping ("make this better") — that belongs to deep-interview — and do not use it for routine debugging you can resolve with a single direct read; this skill is for when the cause is genuinely unclear and evidence needs to be gathered from multiple angles at once.
---

# Trace

Find the real cause of an observed problem by running multiple competing
hypotheses against evidence in parallel, instead of debugging serially under
one assumption.

Explicit invocation only. Nothing in Muse decides on its own that a bug
"looks hard enough" to warrant this skill — you or the user must name it
directly, or another skill's prose must tell the user to invoke it (see
`deep-dive`, which routes here first).

## When to use this

Use it when: the symptom is clear (a failing test, a wrong output, a crash,
a regression between two known-good points) but the cause is not, and a
single obvious read of the code will not settle it. Do not use it for a bug
whose cause is already apparent from the error message or a quick grep —
just fix that directly. Do not use it for open-ended product questions;
route those to `deep-interview` instead.

## Setup

Write working state to `.omm/state/trace-<slug>.md` (create `.omm/state/` if
missing). Never write trace scratch files under `.agents/` or `.muse/` —
both are muse-protected paths that reject unmediated writes.

## Method

1. **State the symptom precisely.** Exact observed behavior, exact expected
   behavior, and the smallest reproduction you have. If you cannot state a
   precise symptom, this is not ready for tracing — ask the user to narrow
   it or fall back to ordinary debugging.
2. **Generate competing hypotheses.** List 2-4 genuinely different candidate
   causes, not variations on the same guess. Each hypothesis should predict
   a different piece of evidence if true.
3. **Spawn parallel evidence-gatherers.** For each hypothesis, `subagent_spawn`
   an `explore` or `debugger` persona with an objective narrowly scoped to
   confirming or falsifying that one hypothesis — not to fixing anything.
   Use `worktree_isolation` only if a hypothesis requires running code with
   local mutations; pure read/grep investigation does not need it. Track the
   spawned ids and poll with `subagent_status`/`subagent_wait`.
4. **Collect evidence, not verdicts.** Read each result with
   `subagent_read_result`. Record what was found for and against each
   hypothesis, including negative results — a hypothesis a subagent could not
   confirm is evidence too.
5. **Score and converge.** Rank hypotheses by evidence weight. If one
   hypothesis is clearly best-supported, state it and the confirming
   evidence. If two remain close, say so plainly rather than picking one to
   look decisive — an honest "still ambiguous between A and B, next probe
   would be X" is a valid outcome of this skill.
6. **Recommend the next probe or the fix.** If the cause is confirmed,
   describe the fix (do not apply it unless the user also asked for a fix in
   the same request). If not confirmed, name the single most informative
   next piece of evidence to gather.

## Output

Write the hypothesis table (hypothesis, evidence for, evidence against,
verdict) to the state file, then present it in a normal reply. Keep it
evidence-first: a hypothesis with no cited evidence is not a valid entry in
the table.

## Handoff

Trace does not automatically start a fix or hand off to another skill; there
is no frontmatter mechanism to chain skills. If the traced cause implies real
scope decisions (not just a one-line fix), say in prose: "Cause identified —
this touches enough surface that it's worth a spec before changing anything.
Run `/deep-interview` next if you want that, or ask me to apply the fix
directly." Then stop and let the user choose.
