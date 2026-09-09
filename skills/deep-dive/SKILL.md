---
name: deep-dive
description: Two-stage front door for a fuzzy problem that might be a bug or might be a product question — run trace first to establish what is actually happening, then deep-interview to turn the confirmed problem into a spec. Use ONLY when the user explicitly asks for a deep dive or invokes /deep-dive, typically when they are not yet sure whether the issue is a defect or a scope question. Do NOT use when the nature of the problem is already clear: go straight to /trace for a known bug, or straight to /deep-interview for a known scoping gap.
---

# Deep Dive

A front door for requests where it is not yet clear whether the real problem
is "something is broken" or "the scope is unclear." Runs two existing skills
in sequence rather than duplicating their logic.

Explicit invocation only, like every skill in this corpus. This skill does
not get triggered by Muse noticing an ambiguous or complex request on its
own — you invoke it, or the user does.

## When to use this

Use it when a request arrives as something like "this whole area feels off"
or "users are complaining about X but I don't know if it's a bug or a
missing feature" — genuine uncertainty about which lane the problem belongs
in. Do not use it when the lane is already obvious: a reproducible crash
goes straight to `/trace`; a clear "we need to decide how this should work"
goes straight to `/deep-interview`. Using this skill on an already-clear
request just adds a redundant stage.

## Stage 1 — Trace

Read the `trace` skill's body (`read_skill trace` or invoke it directly) and
run its method against the reported symptom: state the symptom, generate
competing hypotheses, spawn parallel evidence-gatherers via `subagent_spawn`,
and converge on a best-evidenced explanation. Do this stage in full — do not
skip straight to interviewing because the report sounds product-shaped; the
trace stage is what tells you whether it actually is.

Stop and evaluate after stage 1:

- **Root cause found, fix is small and well-understood** — this is no longer
  a deep-dive matter. Report the cause and the fix in prose and ask the user
  whether to apply it. Do not proceed to stage 2 for a confirmed simple bug.
- **Root cause found, but fixing it right implies a real design decision**
  (multiple valid approaches, user-facing tradeoffs, or scope beyond the
  original symptom) — proceed to stage 2.
- **No clear cause, but the investigation surfaced that the actual ask is
  underspecified product scope rather than a defect** — proceed to stage 2.
- **No clear cause and no scope question — genuinely still stuck** — report
  the trace's evidence table and the next most informative probe. Do not
  force a transition into stage 2 just to have something to hand off.

## Stage 2 — Deep Interview

Read the `deep-interview` skill's body and run its method, seeded with the
trace stage's findings: state what was confirmed, what was ruled out, and
what remains genuinely open. Do not re-ask questions the trace stage already
answered — hand its evidence in as established fact base, not as unknowns to
reopen.

Carry the interview through to its own approval gate. Deep-interview owns
its own spec-writing and approval flow (`.omm/specs/<slug>.md`, explicit
`Approve`/`Request changes`/`Cancel`); do not shortcut it here.

## State

Trace state and interview state are each owned by their own skill
(`.omm/state/trace-<slug>.md`, `.omm/specs/<slug>.md`). This skill does not
introduce a separate state file — it is a sequencing wrapper, not an
independent stage with its own persistence.

## Handoff

Once the interview stage reaches an approved spec, follow deep-interview's
own handoff: tell the user in prose to run `/ralplan .omm/specs/<slug>.md`
next. If stage 1 alone resolved the matter, there is no further handoff —
say so and stop.
