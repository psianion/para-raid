#!/usr/bin/env bash
# Nightly librarian trigger — opens a para-raid Claude session that runs the
# scrypt vault maintenance pass. Events (incl. the digest reply) flow to the
# uxie adapter's webhook because the session is opened with uxie's identity.
#
# Constraints this script designs around (verified against daemon code):
# - adapter_ref must be unique per night: the daemon allows one active
#   session per (adapter, ref) and reclaims a recovering one instead of
#   opening fresh.
# - Nothing auto-closes idle sessions; we close last night's explicitly or
#   max_total_sessions fills up in ~10 nights.
# - Daemon may be quota-paused (503) or down; both notify instead of failing
#   silently.
#
# Requires: para-raid CLI on PATH (or set PARA_RAID_BIN), jq, daemon running,
# [adapters.uxie] configured. Raise [concurrency].turn_timeout_ms in
# config.toml (e.g. 1800000 = 30 min) — the librarian's first turn does real
# work and a timeout kills the session AND drops the reply.
set -u

PARA_RAID_BIN="${PARA_RAID_BIN:-$HOME/para-raid/src/bin/para-raid.ts}"
STATE_DIR="${LIBRARIAN_STATE_DIR:-$HOME/.local/state/librarian}"
PROMPT_FILE="${LIBRARIAN_PROMPT:-$(dirname "$0")/librarian-prompt.txt}"
NOTIFY="${SUP_NOTIFY:-$HOME/bin/sup-notify}"
BUNDLE="${LIBRARIAN_BUNDLE:-scrypt}"

mkdir -p "$STATE_DIR"
SID_FILE="$STATE_DIR/last-session-id"

notify() {
  # ponytail: notifications are best-effort; a missing sup-notify never blocks the run
  [ -x "$NOTIFY" ] && "$NOTIFY" "librarian" "$1" || true
}

run() {
  bun "$PARA_RAID_BIN" "$@"
}

# Close last night's session (nothing auto-reaps idle sessions).
if [ -s "$SID_FILE" ]; then
  run close-session --id "$(cat "$SID_FILE")" >/dev/null 2>&1 || true
  : > "$SID_FILE"
fi

REF="librarian:$(date -u +%F)"
OUT=$(run open-session \
  --adapter-id uxie \
  --adapter-ref "$REF" \
  --bundle "$BUNDLE" \
  --prompt "$(cat "$PROMPT_FILE")" \
  --json 2>&1)
RC=$?

if [ $RC -ne 0 ]; then
  notify "librarian open failed (daemon down/paused/pool_full?): $OUT"
  echo "librarian: open-session failed: $OUT" >&2
  exit 1
fi

SID=$(printf '%s' "$OUT" | jq -r '.session_id // empty')
if [ -z "$SID" ]; then
  notify "librarian open returned no session_id: $OUT"
  echo "librarian: no session_id in response: $OUT" >&2
  exit 1
fi

printf '%s' "$SID" > "$SID_FILE"
echo "librarian: opened session $SID (ref $REF)"
