# oh-my-musecode

An OMC-shaped delivery harness for [Meta Muse Code](https://dev.meta.ai/docs/cookbook#building-with-muse-code)
(the `muse` CLI): a gated pipeline from a vague request to verified working
code. It ships a native Muse plugin manifest, but Muse 1.1.1 reports that
plugins are unavailable in this build. The npm installer handles that limitation
by using `muse skills install` plus a `settings.json` merge instead. See Install
below.

It ports oh-my-claudecode's Tier-0 pipeline — `deep-interview → deep-dive/trace
→ ralplan → ralph`, plus `team` and `cancel` — onto `muse`, respecting
Muse's approval/sandbox/trust/audit model instead of working around it. See
[`docs/recipe.md`](docs/recipe.md) for the full walkthrough and acceptance
run.

## The pipeline

```
/deep-interview  → turns a vague request into an approved spec (.omm/specs/<slug>.md)
/deep-dive       → front door when it's unclear whether the problem is a bug or a scope
                    question; runs trace first, then deep-interview if needed
/trace           → root-causes a concrete symptom via parallel competing hypotheses
/ralplan         → turns an approved spec into a consensus-reviewed PRD (.omm/state/prd.json)
/ralph           → runs the PRD to completion: implement each story, verify its
                    acceptance criteria, loop until done or blocked
/team            → N persona subagents in parallel worktrees on independent tasks
/cancel          → stop whatever pipeline stage is active and clean up .omm/ state
```

Every skill here is **explicit-invocation only**. Muse never fires a skill on
its own because a task looks complex or ambiguous — you (or another skill's
prose) has to name it. Each `SKILL.md` says this in its own body, because
there is no `triggers` field in Muse's skill frontmatter to enforce it.
Sequencing between stages works the same way: no `SKILL.md` chains
automatically into the next one — the skill's body tells you, in prose, what
to run next (`deep-interview` → "run `/ralplan`"; `ralplan` → "run `/ralph`").

## Install from npm

You need Node.js 20 or newer and the `muse` command on your `PATH`. Run:

```bash
npx -y @siddicky/oh-my-musecode install
```

This is the supported npm installation path. If the installer prints
`plugins are not available in this build`, that is a Muse build limitation,
not an installation failure. There is no local setting that enables the plugin
subsystem. The installer detects this response and installs the seven skills at
user scope, then registers the hooks and MCP server directly in Muse settings.

Close and reopen Muse after installation so it reloads the settings. Then check
the complete installation and confirm that Muse can see the skills:

```bash
npx -y @siddicky/oh-my-musecode doctor
muse skills list --source user
```

`doctor` must end with `doctor: healthy`. The skill list must include
`deep-interview`, `deep-dive`, `trace`, `ralplan`, `ralph`, `team`, and
`cancel`. The `--source user` filter is intentional because the fallback
installer installs these skills into Muse's personal skill root. Merely cloning
this repository does not register its top-level `skills/` directory as a Muse
project skill source.

Under `npx`, the invoking package lives in a prunable npm cache directory
(`~/.npm/_npx/<hash>/...`) that npm is free to clean up at any time. Before
this was fixed, `settings.json`'s hook commands and the `omm-state` MCP
server's `args` pointed straight at that cache path, so an install could
silently break the next time npm pruned its cache. `install` now copies the
harness (hooks, `dist/`, personas, and its resolved npm dependency closure)
into a stable, versioned home under the muse config directory —
`$XDG_CONFIG_HOME/muse/oh-my-musecode/<version>/`, or
`~/.config/muse/oh-my-musecode/<version>/` when that's unset — and points
`settings.json` there instead, so the install survives cache pruning.

`install` first probes the local `muse` build: `muse plugins --help` answers
"plugins are not available in this build" on Muse 1.1.1-R2514.1, and registering
`.agents/plugins/marketplace.json` anyway just yields
`muse skills list --source plugin --json` → `{"skills":[],"diagnostics":[]}`
— no discovery, no error, nothing delivered. **There is no `muse plugin
install` command on this build either.**

When plugins are unavailable, the installer skips the plugin route and delivers
through three routes verified to work:

| Piece | Route |
|---|---|
| Skills | `muse skills install <dir> --scope user --force` for each of the 7 skills, landing in `$CONFIG_DIR/skills/` |
| Hooks | a `hooks` entry merged into `$CONFIG_DIR/muse/settings.json`, pointing at the stable home |
| MCP server | an `mcpServers` entry in the same `settings.json`, pointing at the stable home |

(`$CONFIG_DIR` is `~/.config/muse`, or `$XDG_CONFIG_HOME/muse` when that's
set.) The installer also runs an escalation preflight against your local
`muse` build and reports plainly what it finds (see External critic below),
refusing to install if an enterprise policy forbids the only escalation
route entirely. `install` also accepts `--workspace <path>`,
`--config-dir <path>`, and `--dry-run` (preview, writes nothing).

The repo also ships a native `.muse-plugin/plugin.json` manifest — correct
per muse's own documented plugin contract, and what a build with plugins
*enabled* would load directly. `install` detects support at runtime
(`pluginsSupported()`) and would use it automatically on such a build. On Muse
1.1.1-R2514.1 it is inert; do not treat it as the working install path.
`.claude-plugin/` is kept alongside it only for Claude-family tooling
compatibility.

### Uninstalling

```bash
npx -y @siddicky/oh-my-musecode uninstall            # removes our hooks/mcp entries from settings.json, deletes the installed stable home
npx -y @siddicky/oh-my-musecode uninstall --purge     # also removes the 7 installed skills
```

`uninstall` preserves every other value in `settings.json` exactly (the document
is re-serialized as 2-space JSON, so exact original formatting/key order is not
literally preserved, only the values).

### Verifying

```bash
npx -y @siddicky/oh-my-musecode doctor
```

`doctor` is the documented way to verify an install. It re-reads the actual
installed `settings.json`, confirms the 3 hooks (`SessionStart`, `Stop`,
`UserPromptSubmit`) resolve on disk, does a real MCP client handshake
against the `omm-state` server (not just a process-alive check), and
confirms all 7 skills are visible via `muse skills list`. It prints one line
per check and exits non-zero naming the failed check(s) if anything is
wrong.

As a secondary manual check, you can also confirm the skills installed
directly:

```bash
muse skills list --source user
```

All 7 (`deep-interview`, `deep-dive`, `trace`, `ralplan`, `ralph`, `team`,
`cancel`) should appear with `scope: "user"`.

## Skills

Seven skills, installed user-scoped on this build, **explicit-invocation
only** — muse never auto-fires a skill:

| Skill | What it does |
|---|---|
| `deep-interview` | Socratic interview gated by a measured ambiguity score, producing an approved spec |
| `deep-dive` | Two-stage front door: runs `trace` first, then `deep-interview` if the problem turns out to be a scope question |
| `trace` | Root-causes a concrete symptom via parallel competing hypotheses and evidence-gatherers |
| `ralplan` | Turns an approved spec into a consensus-reviewed PRD (`prd.json`) of testable stories |
| `ralph` | Runs the PRD to completion: implement, verify each acceptance criterion, loop until done or blocked |
| `team` | N persona subagents in parallel, each isolated in its own worktree, for genuinely independent work |
| `cancel` | Ends the active pipeline stage and cleans up `.omm/` state — does not revert code |

## Personas

Ten personas (`executor`, `planner`, `architect`, `critic`, `explore`,
`verifier`, `code-reviewer`, `debugger`, `writer`, `test-engineer`), each a
`SOUL.md` body plus a declaratively narrowed toolset in
`personas/manifest.json`.

These are **not muse Agent Definitions** — muse rejects `agents` as a plugin
capability (a Claude-family plugin declaring it gets
`unsupported-agent-schema`/`agent-overlay-inactive`, and the definitions
never activate), so there is no route to register them as first-class agent
types. `scripts/verify-manifest.mjs` fails the build if the plugin manifest
ever tries to declare `agents` anyway.

Instead, the bundled `omm-state` MCP server exposes `persona_list` and
`persona_render` tools: `persona_list` returns every persona id with its
routing description; `persona_render(id)` returns that persona's `SOUL.md`
text plus its narrowed tool allowlist from `personas/manifest.json`, ready
to interpolate into a `subagent_spawn(role, objective, worktree_isolation)`
call. A skill calls `persona_list` to pick the right persona, then
`persona_render` to pull its prompt text and tool allowlist into the
objective it hands to `subagent_spawn` — the narrowing is advisory and the
caller applies it, since muse has no first-class concept of a persona's
tool scope.

## State

Runtime state lives under `.omm/` at the workspace root
(`.omm/specs/`, `.omm/state/`), never under `.agents/` or `.muse/`.

Those two paths are **muse-protected**: a mediated `edit_file`/`write_file`
write there is held for human review with no standing grant, and a shell
write fails read-only at the sandbox. `.omm/` is ordinary, unprotected
workspace state, so hooks and the bundled MCP state server can read and write
it freely — `src/paths.ts` is the single place that enforces this boundary
and refuses any write that resolves into `.agents/`, `.muse/`, or `.git/`.

## External critic

`ralplan` and `ralph` both accept `--critic codex` (or `--critic claude`) to
route consensus review and final verification through an external CLI
process instead of the in-process `critic`/`verifier` personas.

This buys genuine cross-model adversarial review, at two real costs, stated
plainly rather than soft-pedaled:

1. **It's session-wide, not scoped to the critic call.** muse 1.0.3 has no
   named permission profile to escalate just the critic — `--permission-profile
   <id>` reports the profile does not exist, and
   `execution.permission_profiles` validates as `field_not_activated`. The
   only route is launching the **entire session** with `muse
   --disable-sandbox` (or `--yolo`), which removes filesystem and network
   sandboxing for everything in that session, not just the one process that
   needed it.
2. **The external critic's work falls outside Muse's append-only audit
   trail.** Its reasoning and any files it touches are not captured the way
   an in-session `subagent_spawn` result is — `muse export` will show that
   `ralph`/`ralplan` invoked it, not what it did internally.

If an enterprise policy sets `execution.forbid_sandbox_bypass`, both
`--disable-sandbox` and `--yolo` are refused outright and the external
critic cannot run at all; `scripts/install.mjs` checks for this at install
time, and `ralph`/`ralplan` check it again at run time rather than silently
falling back to the in-process critic.

## Development

Installing from a local clone instead of the published package — for
contributors iterating on the harness itself:

```bash
npm install
npm run build
node scripts/install.mjs install --workspace <path> --dry-run   # preview, writes nothing
node scripts/install.mjs install --workspace <path>              # installs for real
node scripts/install.mjs doctor --workspace <path>                # verify
node scripts/install.mjs uninstall --purge                        # remove
```

```bash
npm test           # build + node --test over test/**/*.test.mjs
npm run lint        # verify-manifest.mjs + tsc --noEmit
npm run verify:skills  # validates all 7 skills against the muse binary, failing on any inert frontmatter key
```

## Credits and license

oh-my-musecode is a port of [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)
(MIT, Copyright (c) 2025 Yeachan Heo) to Meta's Muse Code CLI. The pipeline shape
— `deep-interview` → `ralplan` → `ralph`, plus `deep-dive`/`trace`, `team` and
`cancel` — and the PRD-driven persistence loop come from that project. The skill
bodies, personas, hooks, MCP server and installer here were rewritten against
muse's own contracts, because muse's frontmatter subset, invoke-only skills,
protected paths and plugin capability rules differ substantially from Claude Code's.

The persona model follows the Hermes profile pattern documented in Meta's
[meta-model-cookbook](https://github.com/meta-llama/meta-model-cookbook): a
durable SOUL body, a routing description, and a declaratively narrowed toolset,
with project-specific conventions kept out of the persona.

Licensed under the MIT License — see [LICENSE](LICENSE), which retains the
upstream copyright notice as MIT requires.
