---
name: ralplan
description: Turn an approved spec into a consensus-reviewed plan with a PRD (prd.json) of testable stories, gating vague /ralph or /team requests before they run unattended. Use ONLY when explicitly invoked (/ralplan), typically right after deep-interview hands off a spec, or when the user asks to plan before a ralph/team run. Do NOT use for direct small edits, and do not treat an invocation of /ralph or /team as implicitly requesting this — ralplan only runs when named.
---

# Ralplan

Convert an approved spec (or a request specific enough to skip straight to
planning) into a `prd.json` of testable stories, reviewed for consensus
before `ralph` is allowed to run unattended against it.

Explicit invocation only — there is no hook that auto-routes a vague `/ralph`
or `/team` request into this skill. If you want that gating, say so in
prose to the user yourself: "this looks underspecified for an unattended
ralph run — recommend `/ralplan` first," and let the user decide.

## Inputs

- An approved spec at `.omm/specs/<slug>.md` (preferred), or
- A request detailed enough to plan directly, when the user explicitly says
  to skip the interview stage.

## Producing the PRD

Write `.omm/state/prd.json` (create `.omm/state/` if missing) shaped as:

```json
{
  "goal": "one sentence",
  "source_spec": ".omm/specs/<slug>.md",
  "stories": [
    {
      "id": "US-001",
      "title": "short title",
      "description": "what this story delivers",
      "acceptance_criteria": [
        "testable, falsifiable statement",
        "another testable statement"
      ],
      "status": "pending"
    }
  ]
}
```

Every story's acceptance criteria must be testable by inspection, command
output, or reproducible check — not by opinion. "Code is cleaner" is not a
valid criterion; "muse skills validate <path> reports valid: true with zero
unsupported-skill-field diagnostics" is. `ralph` will iterate against this
file story by story, so vague criteria become the loop's failure mode later.

## Consensus review

Before presenting the plan, get a second opinion:

1. Default reviewer is the `critic` persona in-process:
   `subagent_spawn("critic", "review prd.json at .omm/state/prd.json against
   the spec for gaps, untestable criteria, and scope creep")`, then
   `subagent_wait` / `subagent_read_result`.
2. **`--critic=codex` or `--critic=claude` option.** When the user passes
   this, route the review through the named external CLI instead of the
   in-process critic persona. This requires the session to have been
   launched with `muse --disable-sandbox` (or `--yolo`) — say so explicitly
   if it was not, and stop rather than silently falling back to the
   in-process critic, since that changes what was actually reviewed.

   **Be honest about the tradeoff.** Shelling out to an external `codex` or
   `claude` CLI process costs two separate things. First, that review's work
   happens outside Muse's append-only audit trail — the external process's
   reasoning and any files it touches are not captured the way an in-session
   `subagent_spawn` result is. Second, the escalation is session-wide:
   `--disable-sandbox` removes filesystem and network sandboxing for
   everything in the session, not just the critic call.

   On Muse 1.3.0-R3057.1 the `--permission-profile` flag exists, but no
   profile is defined by default (the probe reports `profile does not
   exist`) and the enterprise-config shape that defines one is unconfirmed —
   so unless the session already has a usable profile, the broad carve-out
   is the actual price of an external critic. State this plainly in the
   review summary; do not soft-pedal it as equivalent to the in-process
   critic.
3. Incorporate the critic's findings into the PRD before presenting it.
   Untestable criteria, missing stories implied by the spec, and scope the
   critic flags as unjustified should be fixed, not just noted.

## Approval gate

Present the final `prd.json` contents (or a readable summary of every story
and its criteria) in a normal reply, state which critic mode reviewed it,
and ask for `Approve`, `Request changes`, or `Cancel`. Do not let `ralph`
start from an unapproved PRD.

## Handoff

On approval, say in prose: "PRD approved at `.omm/state/prd.json`. Run
`/ralph` next (add `--critic=codex` or `--critic=claude` to keep the same
external reviewer for verification, and remember that needs the session
launched with `muse --disable-sandbox`)." There is no frontmatter field that
wires this handoff automatically — it exists only because this body says it.
