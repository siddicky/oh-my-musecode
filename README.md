# oh-my-musecode

An OMC-shaped delivery harness for
[Meta Muse Code](https://dev.meta.ai/docs/cookbook#building-with-muse-code) (the
`muse` CLI): a gated pipeline from a vague request to verified working code. It
ships a native Muse plugin manifest. On Muse 1.3.0-R3057.1 plugins are enabled
and the npm installer uses the marketplace plugin route, falling back to
`muse skills install` plus a `settings.json` merge on builds without plugin
support (builds through 1.1.1 reported plugins as unavailable). See Install below.

It ports oh-my-claudecode's Tier-0 pipeline —
`deep-interview → deep-dive/trace
→ ralplan → ralph`, plus `team` and `cancel` —
onto `muse`, respecting Muse's approval/sandbox/trust/audit model instead of
working around it. See [`docs/recipe.md`](docs/recipe.md) for the full
walkthrough and acceptance run, and
[`docs/live-probes-1.3.0.md`](docs/live-probes-1.3.0.md) for the committed
live-binary probe evidence (flags, gates, validate shapes) plus the explicit
unresolved-items list.

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
prose) has to name it. Each `SKILL.md` says this in its own body, because there
is no `triggers` field in Muse's skill frontmatter to enforce it. Sequencing
between stages works the same way: no `SKILL.md` chains automatically into the
next one — the skill's body tells you, in prose, what to run next
(`deep-interview` → "run `/ralplan`"; `ralplan` → "run `/ralph`").

## Dynamic workflows

Beyond the staged pipeline, the repo ships a QuickJS-sandboxed workflow runtime
(`src/workflow/`) plus a `/workflow` skill. Agent-authored JavaScript runs in a
WASM sandbox with session-persistent state and two bridges to the host:

- **PTC** — programmatic tool calling as `await tools.camelCaseName(args)`.
  Guarded mode (default) exposes exactly the static allowlist and enforces
  `maxPtcCalls`. Unleashed mode (`ptcMode: "unleashed"`) drops the call cap and
  resolves any tool name through the host's `toolResolver`.
- **`task()`** — subagent fan-out. Each dispatch runs as a host run with
  started/progress/completed/cancelled lifecycle events, cancel/restart
  propagation, and a per-attempt `AbortSignal` handed to the dispatcher.

Named scripts plus their config (PTC names, PTC mode, subagent map, limits) save
under `.omm/workflows/` for list/re-run/delete. The event stream is the seam a
`/workflows`-style run list consumes; `test/workflow-ui.test.mjs` locks in that
a mixed fan-out (complete + cancel + restart) projects to a consistent run list.

Two honest status notes: the runtime is library-only today — no MCP tool or CLI
verb wires it up yet, so hosts embed it via `createWorkflowTool` (see
`examples/`). And native workflow availability in Muse itself is rollout-gated
per install, not per platform: muse's feature config on this machine
(`~/.local/share/muse/feature-config/`) reports `plugins: true`,
`workflow_tool: true`, and `workflow_api_v2_rollout: false` on Muse Code
1.3.0-R3057.1 (aarch64-apple-darwin) — a headless `muse exec` run whose
`workflow` tool call launched a JavaScript workflow (host API v1), spawned
child subagents, reconciled, and completed was demonstrated on the 1.1.1
build; re-verification on 1.3.0 runs with the schema/headless probes.
Earlier note that this artifact omits the workflow engine was wrong; builds
genuinely compiled without the script engine say so plainly at launch time.
Under `run.workflow_trigger_mode: "explicit"` the native tool fires only on the
user's explicit ask. `src/workflow/native.ts` builds on that native plane: it
compiles this repo's two runtime bridges into scripts for muse's own Workflow
tool — `buildNativePtcScript` maps a PTC batch onto tightly-instructed child
agents (admission enforced at generation time: un-allowlisted or cap-exceeded
calls are never emitted, only reported; the allowlist is fail-closed, and a
deliberate open batch passes the tools it intends to call), and
`buildNativeFanoutScript` maps `task()` dynamic-subagent fan-out onto native
`parallel` (auto-batched to the observed 8-child policy limit) plus the
contract-mandated synthesis child. There is deliberately no native "unleashed"
mode: the QuickJS interpreter's unleashed mode lifts a real runtime boundary
(host-configured allowlist enforced against agent-authored code), while the
native generator receives allowlist and calls from the same caller — an open
mode would only skip a self-written checklist, and V1 scripts have no `tools.*`
bridge to resolve against anyway. `test/workflow-native.test.mjs` checks shape,
refusal semantics, batching, and that every generated script parses as an ES
module.

Run the capability demo from a built checkout:

```bash
npm run build
node examples/unleashed-recon.mjs
```

It runs one recon script guarded (trips `maxPtcCalls=3`, unlisted tools absent)
then unleashed (9 calls sail through, resolver tools discovered dynamically),
plus a session-persistence recall. The captured terminal output is checked in at
`examples/unleashed-recon.output.txt`.

## Install from npm

You need Node.js 20 or newer and the `muse` command on your `PATH`. Run:

```bash
npx -y @siddicky/oh-my-musecode install
```

This is the supported npm installation path. On Muse 1.3.0-R3057.1 the installer
takes the marketplace plugin route. On builds through 1.1.1, where the installer
reports the plugins subsystem as unavailable, that is a Muse build limitation, not
an installation failure — there is no local setting that enables the plugin
subsystem there. The installer detects this response and installs the eight skills at
user scope, then registers the hooks and MCP server directly in Muse settings.

Close and reopen Muse after installation so it reloads the settings. Then check
the complete installation:

```bash
npx -y @siddicky/oh-my-musecode doctor
```

`doctor` must end with `doctor: healthy`. To confirm by hand that Muse sees the
skills, list the source the route you got actually uses: on Muse 1.3.0 the
marketplace route publishes them at plugin scope, so use
`muse skills list --source plugin` and expect eight `plugin:oh-my-musecode:<id>`
entries. Only on a build without plugin support does the fallback installer put
them in Muse's personal skill root, where `muse skills list --source user` shows
them at `scope: "user"`. Either way the eight ids are `deep-interview`,
`deep-dive`, `trace`, `ralplan`, `ralph`, `team`, `cancel`, and `workflow`.
Merely cloning this repository does not register its top-level `skills/`
directory as a Muse project skill source.

If the commands above print a version older than the one you asked for — or fail
with `unknown argument: install` — `npm exec` resolved an already-installed copy
from an ancestor directory instead of fetching from the registry. It prefers
such a local install even when the spec is version-pinned, so a stray
`node_modules/@siddicky/oh-my-musecode` in a parent directory (a `package.json`
in your home directory is the usual culprit) shadows every `npx` run beneath it.
Check with `npx -y @siddicky/oh-my-musecode --version` and remove the stale
install before retrying.

Running these commands from inside a clone of this repository does not work
either: `npm exec` matches the checkout's own `package.json` name, skips the
registry, and exits `127` with `sh: oh-my-musecode: command not found` because
the checkout's bin is not linked. From a clone, call the script directly with
`node scripts/install.mjs install`.

Under `npx`, the invoking package lives in a prunable npm cache directory
(`~/.npm/_npx/<hash>/...`) that npm is free to clean up at any time. Before this
was fixed, `settings.json`'s hook commands and the `omm-state` MCP server's
`args` pointed straight at that cache path, so an install could silently break
the next time npm pruned its cache. `install` now copies the harness (hooks,
`dist/`, personas, and its resolved npm dependency closure) into a stable,
versioned home under the muse config directory —
`$XDG_CONFIG_HOME/muse/oh-my-musecode/<version>/`, or
`~/.config/muse/oh-my-musecode/<version>/` when that's unset — and points
`settings.json` there instead, so the install survives cache pruning.

`install` first probes the local `muse` build. On Muse 1.3.0-R3057.1
`muse plugins --help` lists the full management surface (`install`, `list`,
`inspect`, `approve`, `validate`, `marketplace`, …) and the installer takes
the direct bundle route: it stages a pruned bundle (with built `dist/` plus
the dependency closure) and runs `plugins install <bundle>` + `approve` +
`enable`. It does NOT run `muse plugins marketplace add <git-url>` — a git
marketplace checkout lacks the built `dist/mcp/state-server.js` (gitignored),
so `plugins list --available` reports that source as skipped with
`missing-capability-path: plugin file is not readable`. If you see that
error, remove the git marketplace (`muse plugins marketplace remove
<name>`) and reinstall via the installer instead. On builds through
1.1.1 the probe reported the plugins
subsystem as unavailable, and registering `.agents/plugins/marketplace.json`
anyway just yielded `muse skills list --source plugin --json` →
`{"skills":[],"diagnostics":[]}` — no discovery, no error, nothing delivered.

When plugins are unavailable, the installer skips the plugin route and delivers
through three routes verified to work:

| Piece      | Route                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| Skills     | `muse skills install <dir> --scope user --force` for each of the 8 skills, landing in `$CONFIG_DIR/skills/` |
| Hooks      | a `hooks` entry merged into `$CONFIG_DIR/muse/settings.json`, pointing at the stable home                   |
| MCP server | an `mcpServers` entry in the same `settings.json`, pointing at the stable home                              |

(`$CONFIG_DIR` is `~/.config/muse`, or `$XDG_CONFIG_HOME/muse` when that's set.)
The installer also runs an escalation preflight against your local `muse` build
and reports plainly what it finds (see External critic below), refusing to
install if an enterprise policy forbids the only escalation route entirely.
`install` also accepts `--workspace <path>`, `--config-dir <path>`, and
`--dry-run` (preview, writes nothing).

The repo also ships a native `.muse-plugin/plugin.json` manifest — correct per
muse's own documented plugin contract, and what a build with plugins _enabled_
would load directly. `install` detects support at runtime (`pluginsSupported()`)
and uses it automatically on such a build: on Muse 1.3.0-R3057.1 the manifest
is live via the marketplace route. On builds through 1.1.1 it was inert; do not
treat it as the working install path there. `.claude-plugin/` is kept
alongside it only for Claude-family tooling compatibility.

### Uninstalling

```bash
npx -y @siddicky/oh-my-musecode uninstall            # removes the installed plugin record (and any settings-route entries)
npx -y @siddicky/oh-my-musecode uninstall --purge     # also removes the installed skills
```

On Muse 1.3.0 `uninstall` removes the `oh-my-musecode` plugin record from
Muse's plugin store, then still cleans any settings-route entries (a machine
upgraded from a plugins-off build can have both); running it twice exits
clean. On builds without plugin support it removes the hooks/mcp entries
from `settings.json` and deletes the installed stable home, preserving every
other value in `settings.json` exactly (the document is re-serialized as
2-space JSON, so exact original formatting/key order is not literally
preserved, only the values).

### Verifying

```bash
npx -y @siddicky/oh-my-musecode doctor
```

`doctor` is the documented way to verify an install. It prints one line per
check and exits non-zero naming the failed check(s) if anything is wrong.
On Muse 1.3.0 it checks the marketplace route: the plugin record is
installed and enabled, `inspect` reports it valid and active at the installed
version, all 8 skills are visible via `muse skills list --source plugin`,
and the `omm-state` server cached with the bundle answers a real MCP client
handshake (not just a process-alive check). On builds without plugin support
it instead re-reads the actual installed `settings.json`, confirms the 3
hooks (`SessionStart`, `Stop`, `UserPromptSubmit`) resolve inside the
verified stable home, handshakes the configured server, and confirms the 8
user-scope skills.

As a secondary manual check, you can also confirm the skills installed directly.
On Muse 1.3.0 (marketplace route) they are plugin-scoped:

```bash
muse skills list --source plugin
```

All 8 appear as `plugin:oh-my-musecode:<id>` with `scope: "plugin"`. On a build
without plugin support, the fallback route installs them into the personal skill
root instead, so use `muse skills list --source user` and expect the same 8
(`deep-interview`, `deep-dive`, `trace`, `ralplan`, `ralph`, `team`, `cancel`,
`workflow`) at `scope: "user"`. Seeing user-scope copies *and* a healthy plugin
record usually means the machine was upgraded from a plugins-off build: the
user-scope ones are stale leftovers, and `uninstall --purge` on the old version
(or deleting them from `$CONFIG_DIR/skills/`) clears them.

## Publishing releases

This repository publishes to npm through GitHub Actions using npm Trusted
Publishing. Before the first automated release, open the package settings for
`@siddicky/oh-my-musecode` on npm and add a GitHub Actions trusted publisher
with these values:

- Organization or user: `siddicky`
- Repository: `oh-my-musecode`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allowed action: `npm publish`

Create a GitHub environment named `npm` and protect it with required reviewers
if releases need manual approval. Then update the version in `package.json` and
`package-lock.json`, merge that change, and publish a GitHub Release whose tag
matches the version with a `v` prefix. For version `0.2.0`, use tag `v0.2.0`.
The release workflow rejects a mismatched tag, runs the package tests, and
publishes the public package with npm provenance. It does not use an `NPM_TOKEN`
repository secret.

## Skills

Eight skills, installed user-scoped on this build, **explicit-invocation only**
— muse never auto-fires a skill:

| Skill            | What it does                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `deep-interview` | Socratic interview gated by a measured ambiguity score, producing an approved spec                              |
| `deep-dive`      | Two-stage front door: runs `trace` first, then `deep-interview` if the problem turns out to be a scope question |
| `trace`          | Root-causes a concrete symptom via parallel competing hypotheses and evidence-gatherers                         |
| `ralplan`        | Turns an approved spec into a consensus-reviewed PRD (`prd.json`) of testable stories                           |
| `ralph`          | Runs the PRD to completion: implement, verify each acceptance criterion, loop until done or blocked             |
| `team`           | N persona subagents in parallel, each isolated in its own worktree, for genuinely independent work              |
| `cancel`         | Ends the active pipeline stage and cleans up `.omm/` state — does not revert code                               |
| `workflow`       | Runs agent-authored JS in a QuickJS sandbox: `tools.*` PTC calls plus `task()` subagent fan-out                 |

## Personas

Ten personas (`executor`, `planner`, `architect`, `critic`, `explore`,
`verifier`, `code-reviewer`, `debugger`, `writer`, `test-engineer`), each a
`SOUL.md` body plus a declaratively narrowed toolset in
`personas/manifest.json`.

These are **not muse Agent Definitions** — muse rejects `agents` as a plugin
capability (a Claude-family plugin declaring it gets
`unsupported-agent-schema`/`agent-overlay-inactive`, and the definitions never
activate), so there is no route to register them as first-class agent types.
`scripts/verify-manifest.mjs` fails the build if the plugin manifest ever tries
to declare `agents` anyway.

Instead, the bundled `omm-state` MCP server exposes `persona_list` and
`persona_render` tools: `persona_list` returns every persona id with its routing
description; `persona_render(id)` returns that persona's `SOUL.md` text plus its
narrowed tool allowlist from `personas/manifest.json`, ready to interpolate into
a `subagent_spawn(role, objective, worktree_isolation)` call. A skill calls
`persona_list` to pick the right persona, then `persona_render` to pull its
prompt text and tool allowlist into the objective it hands to `subagent_spawn` —
the narrowing is advisory and the caller applies it, since muse has no
first-class concept of a persona's tool scope.

## State

Runtime state lives under `.omm/` at the workspace root (`.omm/specs/`,
`.omm/state/`), never under `.agents/` or `.muse/`.

Those two paths are **muse-protected**: a mediated `edit_file`/`write_file`
write there is held for human review with no standing grant, and a shell write
fails read-only at the sandbox. `.omm/` is ordinary, unprotected workspace
state, so hooks and the bundled MCP state server can read and write it freely —
`src/paths.ts` is the single place that enforces this boundary and refuses any
write that resolves into `.agents/`, `.muse/`, or `.git/`.

## External critic

`ralplan` and `ralph` both accept `--critic codex` (or `--critic claude`) to
route consensus review and final verification through an external CLI process
instead of the in-process `critic`/`verifier` personas.

This buys genuine cross-model adversarial review, at two real costs, stated
plainly rather than soft-pedaled:

1. **It's session-wide, not scoped to the critic call — unless a profile exists.**
   Muse 1.3.0-R3057.1 ships a real `--permission-profile <id>` flag, but no
   profile is defined by default (an undefined id reports `profile does not
   exist`) and the enterprise-config shape that defines one is unconfirmed, so
   scoping still depends on the installer's preflight result. Without a usable
   profile, the only route is launching the **entire session** with `muse
   --disable-sandbox`
   (or `--yolo`), which removes filesystem and network sandboxing for everything
   in that session, not just the one process that needed it.
2. **The external critic's work falls outside Muse's append-only audit trail.**
   Its reasoning and any files it touches are not captured the way an in-session
   `subagent_spawn` result is — `muse export` will show that `ralph`/`ralplan`
   invoked it, not what it did internally.

If an enterprise policy sets `execution.forbid_sandbox_bypass`, both
`--disable-sandbox` and `--yolo` are refused outright and the external critic
cannot run at all; `scripts/install.mjs` checks for this at install time, and
`ralph`/`ralplan` check it again at run time rather than silently falling back
to the in-process critic.

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
npm run verify:skills  # validates all 8 skills against the muse binary, failing on any inert frontmatter key
bash scripts/e2e-1.3.0.sh  # sandbox E2E vs the real binary: marketplace install → doctor → headless exec + hook fire → uninstall (skips without muse)
```

## Credits and license

oh-my-musecode is a port of
[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) (MIT,
Copyright (c) 2025 Yeachan Heo) to Meta's Muse Code CLI. The pipeline shape —
`deep-interview` → `ralplan` → `ralph`, plus `deep-dive`/`trace`, `team` and
`cancel` — and the PRD-driven persistence loop come from that project. The skill
bodies, personas, hooks, MCP server and installer here were rewritten against
muse's own contracts, because muse's frontmatter subset, invoke-only skills,
protected paths and plugin capability rules differ substantially from Claude
Code's.

The persona model follows the Hermes profile pattern documented in Meta's
[meta-model-cookbook](https://github.com/meta-llama/meta-model-cookbook): a
durable SOUL body, a routing description, and a declaratively narrowed toolset,
with project-specific conventions kept out of the persona.

Licensed under the MIT License — see [LICENSE](LICENSE), which retains the
upstream copyright notice as MIT requires.
