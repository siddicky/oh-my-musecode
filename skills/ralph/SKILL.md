---
name: ralph
description: Run a PRD-driven implementation loop against .omm/state/prd.json, iterating story by story until every acceptance criterion passes, then a final reviewer verification pass. Use ONLY when explicitly invoked (/ralph) against an approved PRD, normally right after /ralplan. Do NOT use without an approved prd.json (run /ralplan first), and do not invoke this for a single small edit — the loop overhead only pays for itself across multiple testable stories.
---

# Ralph

Execute an approved PRD to completion: iterate its stories, implement each
one, verify its acceptance criteria, and loop until all pass or the loop
cannot make further progress. Named for the self-referential "Ralph Wiggum"
loop pattern — run the same verification cycle until it stops finding
problems, not for a fixed number of turns.

Explicit invocation only. This skill does not start itself when `ralplan`
finishes — ralplan's own body tells the user to invoke `/ralph` next in
prose; nothing in frontmatter chains them.

## Precondition

Require `.omm/state/prd.json` to exist and be approved (per `ralplan`'s
gate). If it is missing, stop and tell the user to run `/ralplan` first —
do not improvise a PRD inline just to proceed.

## Loop

For each story in `prd.json` with `status: "pending"`, in order unless the
PRD marks explicit parallelizable groups:

1. Set the story `status` to `"in_progress"` in `prd.json`.
2. Implement the story's described change directly, or delegate to the
   `executor` persona via `subagent_spawn("executor", <story objective +
   acceptance criteria>, worktree_isolation: true)` when the story is large
   enough to isolate — worktree isolation matters here specifically because
   multiple ralph iterations or a parallel `team` run may be touching the
   same repo; an isolated worktree keeps one story's half-finished edits
   from bleeding into another's verification.
3. Check every acceptance criterion for that story against real evidence —
   run the command it names, inspect the output, do not mark a criterion
   passed on the basis of "this should work." A criterion that cannot be
   checked as written is a defect in the PRD, not a license to skip it;
   fix the criterion's wording in `prd.json` and say so, rather than
   silently treating it as satisfied.
4. If all criteria pass, set `status: "done"` and record what evidence
   confirmed each criterion. If any fail, keep `status: "in_progress"`,
   record what failed, and retry the implementation step. Cap retries per
   story (default 3) — after the cap, mark `status: "blocked"` with the
   failure detail and move to the next story rather than looping forever on
   one blocker.
5. Move to the next pending story.

Stop the loop when every story is `"done"` or `"blocked"`. A run that ends
with any `"blocked"` story is not complete — report it as such.

## Reviewer verification pass

Once the loop ends with no pending stories, run a separate verification pass
— never self-approve inside the same implementation context that just wrote
the code:

- Default: `subagent_spawn("verifier", "verify every done story in
  .omm/state/prd.json against its acceptance criteria with independent
  evidence")`, then read its result.
- **`--critic=codex` or `--critic=claude` option.** Route this verification
  pass through the named external CLI instead. This requires the session to
  have been launched with `muse --disable-sandbox` (or `--yolo`). If it was
  not, stop and tell the user rather than quietly downgrading to the
  in-process verifier, since that is a materially different check.

  **State the tradeoff plainly, every time this option is used, not just
  once at setup.** Two distinct costs, and neither should be blurred into
  the other:

  1. The external critic's work happens outside Muse's append-only audit
     trail. Its reasoning and any files it touches are not captured the way
     an in-session `subagent_spawn` result is.
  2. The escalation is **session-wide, not scoped to the critic call**.
     `--disable-sandbox` removes filesystem and network sandboxing for
     everything in that session, not just the one process that needed it.

  On Muse 1.3.0-R3057.1 the `--permission-profile` flag exists, but no
  profile is defined by default (`muse exec --permission-profile <id>`
  reports `profile does not exist` for an undefined id) and the
  enterprise-config shape that defines one is unconfirmed. So unless the
  session already has a usable profile, the broad carve-out is the whole
  cost of the external critic, not an implementation shortcut. This is a
  deliberate, user-reaffirmed tradeoff — it buys genuine cross-model
  adversarial review — but say as much in the final report rather than
  letting it pass unmentioned.

## Enterprise policy interaction

If the workspace's execution policy sets `execution.forbid_sandbox_bypass`,
`--disable-sandbox` and `--yolo` are refused and the external critic cannot
run at all, regardless of `--critic`. Fail with a clear message naming the
policy and the blocked step — do not silently fall back to the in-process
critic/verifier and present it as if the requested external check ran.

## Completion report

Report, per story: id, final status, and the evidence that justified it.
Report the verification pass's mode (in-process or external) and its
verdict. If any story ended `"blocked"`, list it prominently — do not bury a
blocked story under a headline "done."

## Handoff

Ralph is a terminal stage in this pipeline. There is nothing further to
chain to automatically; report completion (or the blocked/failed state) and
stop. If new scope surfaces during implementation that the PRD did not
cover, say so in prose and suggest the user run `/deep-interview` or
`/ralplan` again for that new scope — do not silently fold unplanned work
into the current loop.
