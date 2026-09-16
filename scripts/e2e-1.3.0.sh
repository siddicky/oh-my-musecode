#!/usr/bin/env bash
# Sandbox end-to-end for the 1.3.0 marketplace route, against the REAL binary.
#
# Isolated XDG_CONFIG_HOME + XDG_DATA_HOME throughout, so the developer's real
# muse state is never touched (a final guard snapshots the real plugin store
# before the run and asserts it is byte-identical afterwards, so the check holds
# whether or not the developer has a real install). Skips cleanly when `muse` is
# missing.
#
# The machine's feature-config is seeded into the sandbox data home first:
# with an empty data home the binary fail-closes plugins to "not available"
# (see docs/live-probes-1.3.0.md), which would exercise the settings fallback
# instead of this route. The hook-fire assertion runs the headless session
# with --trust-workspace: without trust, hooks do not fire by design.
#
# Usage: bash scripts/e2e-1.3.0.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v muse >/dev/null 2>&1; then
  echo "e2e: SKIP — muse not on PATH"
  exit 0
fi

CFG="$(mktemp -d /tmp/omm-e2e-cfg-XXXXXX)"
DATA="$(mktemp -d /tmp/omm-e2e-data-XXXXXX)"
WS="$(mktemp -d /tmp/omm-e2e-ws-XXXXXX)"
cleanup() { rm -rf "$CFG" "$DATA" "$WS"; }
trap cleanup EXIT

export XDG_CONFIG_HOME="$CFG" XDG_DATA_HOME="$DATA"

if ! ls "$HOME/.local/share/muse/feature-config/"*.json >/dev/null 2>&1; then
  echo "e2e: SKIP — no machine feature-config to seed the sandbox with"
  exit 0
fi
mkdir -p "$DATA/muse/feature-config"
cp "$HOME/.local/share/muse/feature-config/"*.json "$DATA/muse/feature-config/"

step() { echo "e2e: $*"; }

# The real-store guard below is a before/after comparison, not an absence
# assertion: a developer who followed the README has a real install, and the
# property under test is that this sandbox run does not perturb it.
real_store() {
  env -u XDG_CONFIG_HOME -u XDG_DATA_HOME muse plugins list --json | python3 -c "
import sys, json
print(json.dumps(sorted(
    (r['id'], r.get('version'), r.get('enabled'), r.get('trust'),
     r.get('manifest_sha256'), r.get('package_sha256'), r.get('updated_at'),
     p.get('active'))
    for p in json.load(sys.stdin).get('plugins', [])
    for r in [p['record']]
), sort_keys=True))"
}
REAL_BEFORE="$(real_store)"

step "install via the marketplace route"
out="$(node "$ROOT/scripts/install.mjs" install --workspace "$WS" --config-dir "$CFG")"
echo "$out" | grep -q "Delivery: plugin marketplace" || { echo "e2e: FAIL — wrong route"; echo "$out"; exit 1; }
echo "$out" | grep -q "Enabled oh-my-musecode" || { echo "e2e: FAIL — not enabled"; echo "$out"; exit 1; }

step "doctor healthy"
out="$(node "$ROOT/scripts/install.mjs" doctor --workspace "$WS" --config-dir "$CFG")"
echo "$out" | grep -q "doctor: healthy" || { echo "e2e: FAIL — doctor unhealthy"; echo "$out"; exit 1; }

step "headless exec exits 0"
(cd "$WS" && muse exec --provider echo "e2e smoke") >/dev/null

step "trusted headless exec fires the installed SessionStart hook"
(cd "$WS" && muse exec --trust-workspace --provider echo "e2e hook fire") >/dev/null
test -d "$WS/.omm" || { echo "e2e: FAIL — .omm/ missing, hook did not fire"; exit 1; }

step "all 8 plugin skills visible"
count="$(muse skills list --source plugin --json | python3 -c "import sys,json; print(len([s for s in json.load(sys.stdin).get('skills',[]) if 'oh-my-musecode' in s['id']]))")"
test "$count" = "8" || { echo "e2e: FAIL — expected 8 plugin skills, got $count"; exit 1; }

step "uninstall removes the record; re-uninstall exits 0"
node "$ROOT/scripts/install.mjs" uninstall --config-dir "$CFG" | grep -q "Removed plugin record" || { echo "e2e: FAIL — record not removed"; exit 1; }
node "$ROOT/scripts/install.mjs" uninstall --config-dir "$CFG" >/dev/null

step "real plugin store untouched"
REAL_AFTER="$(real_store)"
if [ "$REAL_BEFORE" != "$REAL_AFTER" ]; then
  echo "e2e: FAIL — sandbox run changed the real plugin store"
  echo "  before: $REAL_BEFORE"
  echo "  after:  $REAL_AFTER"
  exit 1
fi
echo "real store unchanged: $REAL_AFTER"

echo "e2e: PASS — marketplace install, doctor, headless exec, hook fire, 8 skills, uninstall"
