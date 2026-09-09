---
name: deep-interview
description: Run a Socratic interview that turns a vague request into a decision-complete spec, gated by a measured ambiguity score instead of a fixed question count. Use ONLY when the user explicitly asks for a deep interview, invokes /deep-interview, or asks to turn a fuzzy idea into a spec before planning. Do NOT use for ordinary implement/fix/debug requests, for questions with an obvious single answer, or as an automatic first step on complex-looking work — this skill never fires itself; the user or another skill's prose must name it.
---

# Deep Interview

Convert an ambiguous request into a spec that `ralplan` can plan from, by asking
targeted questions and tracking how much ambiguity remains after each round.

This skill only runs when explicitly invoked (`/deep-interview`, or a direct user
ask). Muse never auto-selects a skill because a task looks complex or vague —
there is no hook or heuristic that fires this skill on your behalf. If you are
reading this body, something explicitly asked for it.

## When to use this

Use it when the user's goal is real but underspecified: "build something like
X", "make onboarding better", "port Y into this repo" with no locked scope.
Do not use it for requests that already have a clear, bounded shape — implement
those directly. Do not use it merely because a task touches many files; breadth
is not the same as ambiguity.

## Setup

State lives under `.omm/` at the workspace root — never under `.agents/` or
`.muse/`, both of which are muse-protected: a mediated `edit_file` write there
is held for human review with no standing grant, and a shell write fails
read-only at the sandbox. Create `.omm/specs/` if it does not exist (`.omm/`
is ordinary unprotected workspace state, so `edit_file` and shell writes both
work normally).

## Ambiguity model

Track an explicit ambiguity score (0-100%) across rounds, not a fixed question
budget:

1. Before round 1, enumerate the entities implied by the request (nouns like
   "user", "state directory", "critic", "acceptance criteria") and mark each
   Unknown, Assumed, or Locked.
2. Each round, ask the smallest set of questions (usually 1-3) that would lock
   the most Unknown/Assumed entities. Prefer questions that collapse several
   unknowns at once over exhaustive coverage.
3. After each answer, recompute ambiguity as the fraction of entities still
   Unknown or Assumed, weighted by how load-bearing each entity is to the
   final spec (a naming detail counts for less than a topology decision).
4. Stop asking and move to drafting when ambiguity falls below the configured
   threshold (default 10%; read `execution.ambiguity_threshold` from muse
   config if the project sets one, otherwise use the default and say so).
5. If ambiguity has not measurably dropped for two consecutive rounds, stop
   the interview and report the stall rather than looping — hand the user a
   partial spec with the stuck questions listed as open items instead of
   asking indefinitely.

Optionally probe with a challenge mode for one round when the ontology looks
too comfortable — a Contrarian round ("what would make this the wrong
approach entirely?") or a Simplifier round ("what would the smallest version
that still satisfies the goal look like?"). Use at most one challenge round
unless the user asks for more; note which mode ran in the spec header.

## Producing the spec

Write the interview's output to `.omm/specs/<slug>.md` with:

- One-sentence goal.
- Fact base: what was established (from the codebase, from the user, from
  probing tools) versus assumed.
- Locked decisions, each with the round it was settled in and why.
- Any stated-but-unconfirmed assumptions, flagged explicitly.
- Acceptance criteria the eventual implementation must satisfy.
- Final ambiguity percentage and threshold used.

Do not silently invent scope to fill a section. If a section has nothing real
to say (no risks, no deferred items), write "None" rather than padding it.

## Explicit approval gate

Present the complete spec in a normal reply and ask the user to `Approve`,
`Request changes`, or `Cancel`. Do not treat silence, a topic change, or your
own confidence as approval. On `Request changes`, revise the same spec file
and re-present it. On `Cancel`, stop and leave the spec file as a draft,
clearly marked unapproved at the top.

## Handoff

This skill does not chain into the next stage automatically — nothing in Muse
reads a "next-skill" field from frontmatter; that field does not exist here.
Once the spec is approved, say so in plain prose and tell the user the next
step in the pipeline: "Spec approved and saved to `.omm/specs/<slug>.md`. Run
`/ralplan .omm/specs/<slug>.md` next to turn this into a plan." Then stop.
Do not start planning or implementation yourself from inside this skill.

## Notes on personas

If parts of the interview benefit from a second perspective (for example,
probing technical feasibility of a locked decision), you may
`subagent_spawn` the `architect` or `explore` persona with a narrow objective
and read its result back with `subagent_read_result` before continuing the
interview. These are prompt personas rendered into the spawn call, not muse
Agent Definitions — muse rejects `agents` as a plugin capability, so no
persona is registered as a first-class agent type.
