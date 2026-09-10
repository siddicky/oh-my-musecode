# oh-my-musecode: a gated delivery pipeline that self-hosts

|  |  |
|---|---|
| **Section** | Muse Code plugin |
| **Time to complete** | ~45 min |
| **Model** | `meta` provider (any Meta model muse is configured for) |
| **Harness** | Muse Code (the `muse` CLI, 1.0.3) |
| **Prerequisites** | Node.js >= 20, `muse` on `PATH`, a workspace you can trust |

## Summary

oh-my-musecode ports oh-my-claudecode's Tier-0 delivery pipeline —
`deep-interview → deep-dive/trace → ralplan → ralph`, plus `team` and
`cancel` — onto the `muse` CLI. It ships seven skills and ten personas whose
`SOUL.md` text and tool allowlists are pulled in on demand via the bundled
`omm-state` MCP server's `persona_list`/`persona_render` tools, ready to
interpolate into a `subagent_spawn` objective. Everything is wired together
with hooks rather than frontmatter, because Muse's skill frontmatter carries
no `pipeline` or `next-skill` field to read. Each skill's own body tells the
user, in prose, what to run next.

The repo ships a native `.muse-plugin/plugin.json` manifest, correct per
muse's own documented plugin contract — but muse 1.0.3-R2198.1's plugins
subsystem is disabled outright (`muse plugins --help` answers "plugins are
not available in this build"), so on this build the manifest is inert and
delivery goes through `muse skills install`, a `hooks` entry, and an
`mcpServers` entry in `settings.json` instead. See Orchestration contract
and step 1 below for exactly which route runs today.

This recipe walks the repo's own acceptance run: installing it, then driving
`/deep-interview → /ralplan --critic codex → /ralph --critic codex` against
this same repository. The run is self-hosting — it builds one of the repo's
own seven skills — so a failure here is a real defect, not a toy demo. What
is actually verified as of this writing, and what is not, is stated plainly
in the Proof Point section below — the full pipeline run has not yet been
executed end to end in a muse session.

## When To Use

Use this recipe when you want a repeatable pipeline for turning a vague request
into an approved spec, a reviewed PRD, and verified working code, with an
optional cross-model adversarial review at the planning and verification
gates — and you want that pipeline to run on `muse` specifically, respecting
its approval/sandbox/trust/audit model instead of working around it.

Do not use it for a single small edit — the interview and planning stages exist
to gate genuinely ambiguous or multi-story work, and their overhead does not
pay for itself on a one-line fix. Do not reach for `--critic codex` casually:
it requires disabling the session sandbox for the whole run, not just the
critic call (see Proof Point and What Can Go Wrong below). If the work is
already well-specified, skip straight to `/ralplan` or even `/ralph` with a
hand-written `prd.json`.

## Orchestration contract

| Contract | Muse mechanism |
|---|---|
| Skill catalog stays cheap | Skills load as summaries at session open; `read_skill`/invocation pulls the full `SKILL.md` for one turn only |
| Skills never self-trigger | Explicit-invocation only — no `triggers` field exists in Muse's skill frontmatter subset (`name`, `description`, `allowed-tools`); each `SKILL.md` body says so in prose |
| Pipeline sequencing | No `next-skill`/`handoff`/`pipeline` frontmatter field exists on Muse. Each skill's body tells the user in prose what to run next (`deep-interview` → "run `/ralplan`"; `ralplan` → "run `/ralph`") |
| Personas | Ten `SOUL.md` files, pulled in via the `omm-state` MCP server's `persona_list`/`persona_render` tools and interpolated into `subagent_spawn(role, objective, worktree_isolation)` prompt text — not muse Agent Definitions. A Claude-family plugin declaring `agents` gets `unsupported-agent-schema`/`agent-overlay-inactive`, so there is no route to register personas as first-class agent types |
| Parallel work isolation | `team` and multi-story `ralph` runs pass `worktree_isolation: true` to `subagent_spawn`, landing each child in its own `.muse/worktrees/` checkout |
| Runtime state | `.omm/` at the workspace root — `.agents/` and `.muse/` are muse-protected: a mediated `edit_file` write there is held for human review with no standing grant, and a shell write fails read-only at the sandbox |
| Keyword routing / bootstrap / verification gate | `UserPromptSubmit`, `SessionStart`, and `Stop` hooks (`hooks/hooks.json`, `hooks/*.mjs`) restore what inert frontmatter cannot do |
| Delivery on this build | `muse plugins` is disabled entirely on 1.0.3-R2198.1 ("plugins are not available in this build"), so `scripts/install.mjs` runs `muse skills install --scope user` per skill and merges `hooks`/`mcpServers` into `$CONFIG_DIR/muse/settings.json`. The repo also ships a native `.muse-plugin/plugin.json`, forward-looking for a build with plugins enabled — inert today; there is no `muse plugin install` command on any build |

## Walkthrough: the self-hosting acceptance run

### 1. Install

```bash
git clone <this repo> oh-my-musecode && cd oh-my-musecode
npm install
npm run build
node scripts/install.mjs install --workspace /path/to/oh-my-musecode --dry-run
```

`--dry-run` prints what the installer would do without touching disk. It
first probes `muse plugins --help`: on 1.0.3-R2198.1 that answers "plugins
are not available in this build", so the installer takes the settings route
instead of writing a plugin marketplace entry that muse would silently
never load. Drop `--dry-run` to install for real. For this self-hosting run,
the target workspace is this repo itself:

```bash
node scripts/install.mjs install --workspace .
```

This runs three routes, each verified to work on 1.0.3-R2198.1:

1. `muse skills install <dir> --scope user --force` for each of the 7
   skills, landing in `$CONFIG_DIR/skills/`.
2. A `hooks` entry merged into `$CONFIG_DIR/muse/settings.json` (a
   SessionStart hook installed this way is what creates `.omm/`).
3. An `mcpServers` entry for `omm-state` in the same `settings.json`.

(`$CONFIG_DIR` is `~/.config/muse`, or `$XDG_CONFIG_HOME/muse` when set.)

The installer also runs an escalation preflight against the local `muse`
build and prints, plainly, whether named permission profiles are available.
On muse 1.0.3 they are not — read the "External critic posture" section it
prints; the rest of this walkthrough depends on it.

### 2. Confirm the install and start a session

```bash
muse skills list --source user
```

All seven skills (`deep-interview`, `deep-dive`, `trace`, `ralplan`,
`ralph`, `team`, `cancel`) should appear with `scope: "user"`. Unlike a
plugin-loaded skill, a user-scoped skill installed this way does not need
`--trust-workspace` to be visible — but the hooks and MCP server delivered
through `settings.json` still only take effect inside a real `muse` session,
so start one before continuing:

```bash
muse --trust-workspace
```

(or `--yolo`, which also disables approval and sandboxing — do not use that
here yet; the external-critic stage below is the point where sandboxing
actually needs to come off, and that decision should be explicit, not a side
effect of an earlier `--yolo`.)

### 3. `/deep-interview`

Inside the trusted session, pick one of the plugin's own seven skills that has
room for a real design decision (for example, tightening the `team` skill's
worktree-slot-queueing behavior) and run:

```
/deep-interview Improve <chosen skill>'s <specific rough edge>.
```

Answer the interview's questions until it reports ambiguity below threshold
and presents a spec. Approve it. The spec lands at `.omm/specs/<slug>.md`.

### 4. `/ralplan --critic codex`

```
/ralplan .omm/specs/<slug>.md --critic codex
```

`ralplan` writes `.omm/state/prd.json`, then routes the consensus review
through an external `codex` CLI process instead of the in-process `critic`
persona. This is the point where the earlier preflight result matters: routing
through an external CLI requires the *whole session* to have been launched
with sandboxing disabled. If you started with plain `--trust-workspace`, stop
here, exit, and relaunch as:

```bash
muse --disable-sandbox --trust-workspace
```

This is **session-wide**, not scoped to the critic call — every tool call for
the rest of the session runs unsandboxed, not just the `codex exec` process
`ralplan` shells out to. It also means the external critic's reasoning and any
files it touches are **not captured in Muse's append-only session log** the
way an in-session `subagent_spawn` result is; that portion of the review
happens outside the audit trail this recipe otherwise relies on as evidence.
Re-run `/ralplan .omm/specs/<slug>.md --critic codex` in the relaunched
session. Review the PRD and its critic findings, then approve.

### 5. `/ralph --critic codex`

```
/ralph --critic codex
```

`ralph` iterates `.omm/state/prd.json` story by story, implementing each one
(directly or via `subagent_spawn("executor", ..., worktree_isolation: true)`
for larger stories) and checking every acceptance criterion against real
command output. When every story is `done` or `blocked`, it runs a final
verification pass — here, through the same external `codex` CLI, under the
same session-wide `--disable-sandbox` already in effect. Same two costs as
step 4 apply again to this pass; `ralph`'s own completion report states them
again rather than assuming step 4 already covered it.

## Proof Point

The run is verified done when all of the following hold. Some of these are
already true today and are stated as such below; the rest depend on
actually driving steps 3–5 of the walkthrough, which has **not yet been
executed end to end in a muse session** — this recipe describes the run to
perform, it does not claim the run has happened.

**Verified today, independent of the pipeline run:**

1. `muse skills validate <path>` reports `valid`, with no
   `unsupported-skill-field` diagnostics and an empty
   `compatibility.unknown_fields`, for each of the seven skill directories
   under `skills/` (`npm run verify:skills` checks this automatically).
2. `muse skills install --scope user --force` installs all seven skills, and
   `muse skills list --source user` lists all seven with `scope: "user"`.
3. `npm test` passes: 84 tests covering routing, state-root protection,
   persona manifest, MCP state server, and installer preflight.
4. `muse --trust-workspace` (installed via `settings.json`, not a plugin
   marketplace) fires the `SessionStart` hook, which creates `.omm/`.
5. The `omm-state` MCP server completes an `initialize` handshake and
   refuses reads/writes into protected or symlinked paths.

**Still outstanding — to confirm by actually running steps 3–5 above:**

6. The `.omm/state/prd.json` story implemented by the run has
   `status: "done"` with recorded evidence per acceptance criterion, and
   none of its stories are `"blocked"`.
7. `muse export --last --out trajectory.json` produces a self-contained,
   append-only session log covering steps 3–5 of the walkthrough. It will
   show the in-session tool calls (skill invocations, `subagent_spawn`
   children, file writes under `.omm/`) but — honestly — will **not** show
   what the external `codex` CLI process did internally during the `--critic
   codex` stages; only that `ralph`/`ralplan` invoked it and what came back
   on its stdout/stderr, if the skill body chose to record that.

## What can go wrong

**Skills installed at the wrong scope, or plugins assumed to be on.** These
skills are installed with `--scope user`, into `$CONFIG_DIR/skills/`, not as
a workspace plugin — `muse plugins` is disabled on this build, so a
registered plugin marketplace loads nothing (`muse skills list --source
plugin --json` → `{"skills":[],"diagnostics":[]}`, silently, with no
diagnostic pointing at the cause). Confirm the real install with `muse
skills list --source user` instead. The hooks and `omm-state` MCP server
delivered via `$CONFIG_DIR/muse/settings.json` still only run inside an
actual `muse` session — launch with `muse --trust-workspace` (or `--yolo`)
before expecting the `SessionStart` bootstrap or `UserPromptSubmit` routing
hook to fire.

**Enterprise policy forbids the sandbox bypass.** If the workspace's
`execution` policy plane sets `forbid_sandbox_bypass`, both `--disable-sandbox`
and `--yolo` are refused outright. `scripts/install.mjs` checks for this at
install time and refuses to install rather than delivering a skill set whose
`--critic codex`/`--critic claude` paths cannot work; `ralph` and `ralplan`
check it again at run time and fail with a named-policy error rather than
silently falling back to the in-process critic and reporting as if the
external review ran. There is no narrower escalation route on muse 1.0.3 —
named permission profiles are not creatable on this build
(`execution.permission_profiles` validates `field_not_activated`, and
`muse exec --permission-profile <id>` reports the profile does not exist) — so
under this policy, the external-critic option is simply unavailable; use the
in-process `critic`/`verifier` personas instead.

**Headless `muse exec` can't answer approval prompts.** Running any of these
skills under `muse exec` (rather than the interactive TUI) with the default
`--approval-mode on-request` will stall on the first mediated tool call,
since there is no human present to answer it. Either pass
`--approval-mode never` (accepting that every tool call clears automatically
for that run) or `--user-input-auto-resolve` to auto-cancel `request_user_input`
prompts instead of hanging — know which of those two you actually want before
running `ralph` headless, since they trade off differently between unattended
progress and silently skipped decisions.
