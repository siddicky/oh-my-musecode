# Live probes — Muse Code 1.3.0-R3057.1

All outputs below were captured from `muse --version` reporting
`Muse Code 1.3.0 (1.3.0-R3057.1)` on aarch64-apple-darwin. This note is the
committed probe evidence for the 1.3.0 catch-up: the per-flag statements for
US-005, the probe citation for the feature-config values stated in README.md
and `src/workflow/native.ts`, and the validate/install shapes behind the
US-002 route design.

## Per-flag presence (from `muse --help`)

The full 97-line output is committed at
`test/fixtures/live-help-1.3.0.txt`; the table below states each
PRD-named flag present or missing.

| Flag | Present | Notes |
| ---- | ------- | ----- |
| `--agents <JSON>` | yes | "Supply one ephemeral agent-definition overlay" (top-level help; accepted by `exec` too but not listed there) |
| `--preset <NAME>` | yes | "Run a built-in preset: native-basic, miniswe". Bogus value rejected: `unknown preset bogus; expected native-basic\|miniswe` |
| `ultra` (reasoning effort) | yes | `--reasoning-effort` accepts `none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra` (default: high). `--reasoning-effort ultra` parses; it is refused only in combination with `--provider echo` (`--reasoning-effort is not supported with --provider echo`) |
| `--subagent-worktree-isolation` | yes | "Compatibility flag; capability defaults on. Only an affirmative per-child request asks for isolation; omission stays shared. Requests may reject when capability, provider, or Git prerequisites are unavailable." |
| `--permission-profile <ID>` | yes | Session flag, also on `muse exec`. No profile defined by default: an undefined id reports `Permission profile '<id>' is unavailable: profile does not exist.` (exit 1) |
| `--approval-mode`, `--approval-judge`, `--sandbox-network`, `--disable-write`, `--disable-shell`, `--parallel-tool-calls`, `--session-message` (`session-message` subcommand), `--serve` (`serve` subcommand), `--schema` (`schema` subcommand), `-w/--worktree` | yes | New since 1.1.1; listed for inventory completeness, no persona interaction |

## `--agents` overlay behavior (from `muse exec --provider echo` trials)

- `--agents '{}'` and `--agents '{"agents":[{"id":"x"}]}'`: accepted (session runs; no observable roster effect under the echo provider).
- `--agents 'not-json'` and `--agents '[{"id":"x"}]'` (array): rejected with `Session Agent Definition JSON is invalid`.
- Conclusion: the overlay is session-startup CLI surface ("Session Agent
  Definition JSON"); it must be a JSON object. Its inner schema and roster
  effects are unobservable headlessly (the echo provider cannot show agent
  rosters; the meta provider was not exercised).

## Feature config (from `~/.local/share/muse/feature-config/7075626c6963.json`)

```json
{"schema_version": 1, "ttl_seconds": 3600, "gates": {
  "local_session_messaging": true, "monitor": false, "plugins": true,
  "subscription_launch": true, "subscription_upsell": true, "voice": true,
  "voice_default_on": true, "web_fetch": true,
  "workflow_api_v2_rollout": false, "workflow_tool": true}}
```

Live values: `plugins: true`, `workflow_tool: true`,
`workflow_api_v2_rollout: false`.

## Permission-profile probe (from the installer's exact probe)

`muse exec --provider echo --permission-profile __omm_probe__ x` →
exit 1, stderr `Permission profile '__omm_probe__' is unavailable: profile
does not exist.` The `--permission-profile` flag is real, but with no
profile defined there is nothing to scope to. The enterprise-config shape
that defines a profile is unconfirmed (`execution.permission_profiles` was
rejected as `unknown_member` on both the defaults and policy planes with the
guessed shape; see US-007).

## Plugin validation shapes (from `muse plugins validate --json`)

- Minimal bundle (single `.muse-plugin/plugin.json` + one skill): `{"valid":
  true, ...}`.
- Manifest declaring an `agents` capability: valid `true` with warning
  `unsupported-capability`: "plugin agents capabilities are not supported in
  this phase".
- Unknown capability field: valid `true` with warning `unsupported-field`:
  "plugin capability field `X` is not used by this runtime".
- Bundle containing symlinks: `invalid-plugin-package`, "plugin contains
  symlink entries and cannot be installed".
- Bundle with a full `node_modules` tree (~4000 files): `Agent Definition
  inventory derivation failed closed`. Bisected to a file-count interaction
  (passes at ~2900 files, fails at ~3700); the staged bundle keeps ~1600
  files after pruning non-runtime entries.
- Workspace `<ws>/.agents/plugins/marketplace.json` written by hand is NOT
  honored: `plugins list --available` reports `{"available":[]}` with the
  file present.

## Install / approve / enable / remove shapes (from live trials)

- `plugins install <bundle> --scope user --json` → `{"installed":
  {id, version, enabled: true, trust: "user-local", source, cache_path,
  ...}}`. Reinstalling the same bundle succeeds (refresh, still enabled).
- `plugins approve <id> --json` → `{"decision": "approve",
  "runtime_capabilities": [{stable_id, trusted_definition_hash, enabled}]}`.
  With no runtime capabilities (skills-only bundle): error payload
  `runtime-capability-not-found`, "no runtime capabilities match `<id>`".
- `plugins enable/disable <id> --json` → `{"enable"|"disable": {...}}`.
- `plugins inspect <id> --json` → `{record, plugin, valid: true, active:
  true|false, diagnostics: []}`.
- `plugins remove <id> --json` → `{"removed": "<id>", cache_path, ...}`.
- `skills list --source plugin --json` lists installed plugins' skills as
  `plugin:<plugin-id>:<skill-id>`.

## Wire schema (from `muse schema generate-json-schema --out`, stable surface)

- Method index (47 entries) includes `workflow/cancel`,
  `workflow/childControl`, the full `subagent/*` family, and
  `session/setReasoningEffort` — the native workflow plane exists on the
  wire, not just in help text.
- `ReasoningEffort` is a closed enum
  (`none|minimal|low|medium|high|xhigh|max|ultra`): `ultra` is schema-level,
  matching the CLI flag.
- `execution.*` appears ZERO times: enterprise execution config
  (`ambiguity_threshold`, `forbid_sandbox_bypass`, `permission_profiles`)
  is not described by the wire schema, so the schema cannot confirm or deny
  any `execution.*` assumption (carried in US-007).
- No child-count or fan-out limit appears anywhere (`agentType`,
  `isolation`, `maxItems`, `fanout`: zero hits): the 8-child parallel-batch
  assumption rests on the observed 1.1.1 run only, not on the 1.3.0 schema
  (carried in US-007).

## Headless flags (for US-006)

- Headless runs use `muse exec --provider echo <prompt>` (echo provider:
  no model, no network, deterministic). The `--provider meta` path was not
  exercised (no provider credentials configured in the sandbox).
- A headless run against the staged artifact means: isolated
  `XDG_CONFIG_HOME` + `XDG_DATA_HOME`, `install` + `doctor` through the
  marketplace route, then `muse exec --provider echo` (exit 0) with
  `skills list --source plugin` showing the plugin's skills. The committed
  `scripts/e2e-1.3.0.sh` runs this full cycle (skips cleanly without `muse`).
- Hook fire, observed: with the plugin installed, a trusted headless session
  (`muse exec --trust-workspace --provider echo`) creates `.omm/` in the
  workspace — the installed SessionStart hook ran from the cached bundle.
  Control: the same run with no plugin installed creates no `.omm/`.
  Without `--trust-workspace`, hooks do not fire by design ("workspace is
  untrusted").
- Sandbox prerequisites (environment, not artifact): the plugins subsystem
  gates on the feature-config in the DATA home — with an empty
  `$XDG_DATA_HOME`, `plugins --help` reports "not available in this build"
  and the installer correctly takes the settings fallback. The marketplace
  E2E therefore seeds `$XDG_DATA_HOME/muse/feature-config/` from the
  machine's own gates first (no self-seeding was observed from
  `config status`).
- Live `muse` self-initializes a default `settings.json` (`schema_version`
  + `tui` state) on first run in a fresh config home. The marketplace route
  writes no settings ENTRIES; a `settings.json` file existing after a
  marketplace install is muse's own doing.
- SDK registry currency is RESOLVED, not carried: installed
  `@modelcontextprotocol/sdk` 1.30.0 equals the registry latest (1.30.0,
  2026-07-27).

## Unresolved items (US-007 — no silent drops)

Each item states what was probed, what remains unknown, and why it does not
block 1.3.0 compatibility.

0. **SDK registry currency — RESOLVED, recorded here so it is where the PRD
   says to look.** Installed `@modelcontextprotocol/sdk` 1.30.0 equals the
   registry latest (1.30.0, 2026-07-27); nothing to carry.

1. **Native marketplace-catalog shape.** Probed: `marketplace add` reads a
   catalog at `marketplace.json`, `.agents/plugins/marketplace.json`, or
   `.claude-plugin/marketplace.json` relative to the source; the repo's own
   `.claude-plugin/marketplace.json` (`{name, owner, metadata, plugins[]}`)
   was never round-tripped through `marketplace add`. Unknown: the exact
   1.3.0 native catalog schema. Unblocked: the locked route (direct
   `plugins install <path>`) needs no catalog.
2. **`execution.*` vs live schema.** Probed: `execution`, `ambiguity`,
   `forbid_sandbox_bypass` appear zero times in the exported wire schema —
   enterprise execution config lives on a different plane. Unknown: whether
   keys like `execution.ambiguity_threshold` exist as live config (only CLI
   error vocabulary and help text attest them). Unblocked: every consumer
   treats the probes three-valued and fails closed; `deep-interview` falls
   back to its stated 10% default.
3. **8-child parallel-batch limit.** Observed on the 1.1.1 run; absent from
   the 1.3.0 schema (no `maxItems`/`fanout`/child count anywhere) and not
   re-exercised (a 9-wide batch needs the meta provider). Unblocked:
   batching to 8 is conservative — smaller batches are always accepted, so a
   raised limit would only mean under-batching, never failure.
4. **Validate-diff remainder (`tools`).** Diffed and pinned for `agents` and
   unknown fields (test/verify-manifest-diff.test.mjs). Remainder: live
   1.3.0 silently accepts a `tools` capability (no diagnostic), so IF `tools`
   capabilities actually load, our fail-closed rejection blocks a real
   feature. Unblocked: this repo declares no `tools` capability, so the
   rejection costs nothing today.
5. **Hook firing in a live session + MCP OAuth.** Mostly resolved:
   plugin-route doctor (installed/enabled/valid+active/8-skills/mcp-spawns,
   all E2E-proven), full `skills validate` 8/8, hooks+MCP approved together
   (4 runtime capabilities) — plus OBSERVED hook firing: a trusted headless
   session with the plugin installed creates `.omm/` via the installed
   SessionStart hook (control without the plugin creates none; untrusted
   sessions fire no hooks by design). Remainder: `mcp login/logout` OAuth
   was not probed. Unblocked: our MCP server is stdio (no OAuth flow exists
   to break).
6. **v2 gate on non-marketplace installs.** Probed: this machine's gates
   report `workflow_api_v2_rollout: false`; generators target host API v1
   explicitly. Unknown: behavior under a v2-true rollout. Unblocked: v2 is
   off here and nothing in the artifact opts into it.
7. **Plugin-vs-settings-merge route decision.** Confirmed, no reversal: the
   marketplace route is implemented, tested, and sandbox-E2E-proven as
   primary on plugin-capable builds; the settings merge remains as the
   fallback for builds without plugin support (covered by the legacy-route
   tests).
8. **No 1.1.1 binary for diffing.** There is no 1.1.1 (or 1.2) binary to
   diff against, so 1.2-vs-1.3 attribution is impossible from the public
   changelog (covers ≤1.1.1) plus the live binary. Unblocked: every
   historical claim is scoped to "builds through 1.1.1" collectively, and
   every forward claim is grounded on a 1.3.0 probe captured in this note.
9. **Enterprise profile-definition shape.** Probed: `--permission-profile`
   is real but nothing is defined by default; the guessed
   `execution.permission_profiles` document shape was rejected as
   `unknown_member` on both config planes. Unknown: the real shape that
   defines a profile. Unblocked: the preflight reports "no usable profile
   defined" and the external-critic path fails safe to `--disable-sandbox`
   or the in-process critic; nothing writes profile config.

## Known failure kept as documentation (not fixed)

- Validating the raw repo root fails by design of the install flow, not by
  accident. Exact command and output:
  `muse plugins validate . --json` → `{"error": {"code":
  "invalid-plugin-package", "message": "Agent Definition inventory
  derivation failed closed", ...}}` plus warning `invalid-plugin-package`:
  "plugin contains symlink entries and cannot be installed; replace symlinks
  with regular files" (path: `node_modules/.bin/acorn`). The installer never
  installs the raw root: it stages the pruned bundle
  (`scripts/plugin-bundle.mjs`), which validates `{"valid": true}`.
