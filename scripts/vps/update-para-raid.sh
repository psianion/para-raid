#!/usr/bin/env bash
# update-para-raid — git pull, typecheck gate, restart the systemd --user
# service, healthcheck, rollback (code + DB) on failure.
#
# Idempotent. Safe to run multiple times. Single-instance via flock.
# Logs every run to /var/log/sup-updates/para-raid.log with ISO-8601 timestamps.
#
# Exit codes:
#   0  success (or no-op when already on origin/main)
#   1  post-start healthcheck failed (rollback attempted)
#   2  pull / install / typecheck failed (rollback attempted)
#   3  another instance already running
#   4  misconfiguration (repo not found)
#
# Install:
#   sudo install -m 0755 -o ubuntu -g ubuntu \
#     scripts/vps/update-para-raid.sh /home/ubuntu/bin/update-para-raid
#
# Run:
#   ~/bin/update-para-raid          # manual
#   crontab -e  → 45 2 * * * /home/ubuntu/bin/update-para-raid  # nightly, staggered per STACK.md

set -euo pipefail

LOG_DIR=/var/log/sup-updates
LOG=$LOG_DIR/para-raid.log
LOCK=/var/lock/update-para-raid.lock

# Repo layout on the VPS isn't verified from here — the vault bind-mount
# path (/home/ubuntu/para-raid/scrypt-vault) suggests the repo itself lives
# at /home/ubuntu/para-raid, but override with PARARAID_REPO if not.
REPO="${PARARAID_REPO:-/home/ubuntu/para-raid}"
DATA_DIR="${PARARAID_DATA_DIR:-$HOME/.local/state/para-raid}"
DB=para-raid.db

mkdir -p "$LOG_DIR"

# `|| true`: log is called mid-rollback; a tee failure (disk full, rotated log)
# must never let set -e abort the script with the service stopped.
log()  { printf '[%s] %s\n' "$(date -Iseconds)" "$*" | tee -a "$LOG" >&2 || true; }
notify() { [ -x "$HOME/bin/sup-notify" ] && "$HOME/bin/sup-notify" "$1" || true; }
fail() { log "FAIL: $1"; notify "update-para-raid FAILED: $1"; exit "${2:-1}"; }

# Single-instance lock — prevents cron + manual collision and concurrent restarts.
exec 9>"$LOCK"
flock -n 9 || fail "another update-para-raid run is in progress" 3

log "=== update-para-raid start (uid=$(id -u) host=$(hostname)) ==="

[[ -d "$REPO/.git" ]] || fail "repo not found at $REPO — set PARARAID_REPO" 4

git -C "$REPO" fetch >> "$LOG" 2>&1 || fail "git fetch failed" 2

LOCAL=$(git -C "$REPO" rev-parse HEAD)
REMOTE=$(git -C "$REPO" rev-parse origin/main)

if [[ "$LOCAL" == "$REMOTE" ]]; then
  if systemctl --user is-active --quiet para-raid; then
    log "no-op: already at origin/main ($LOCAL)"
    log "=== update-para-raid done (no-op) ==="
    exit 0
  fi
  # A prior run died between stop and start (SHAs match but service is down).
  # Finish what it started: deps may be stale for the pulled HEAD.
  log "at origin/main but service is down — finishing interrupted update"
  bun install --frozen-lockfile --cwd "$REPO" >> "$LOG" 2>&1 || fail "bun install failed during self-heal" 2
  systemctl --user start para-raid || fail "systemctl start failed during self-heal" 1
  notify "para-raid: self-healed an interrupted update (service was down at origin/main)"
  log "=== update-para-raid done (self-heal restart) ==="
  exit 0
fi

PREV=$LOCAL
log "pre: HEAD=$PREV target=$REMOTE"

log "stopping para-raid"
systemctl --user stop para-raid || fail "systemctl stop failed" 2

# Snapshot the SQLite DB + WAL/SHM sidecars before touching anything.
# Migrations are forward-only with no down path — once migration 002+
# exists, rolling back code without also restoring the DB corrupts it.
SNAPSHOT=$(mktemp -d)
trap 'rm -rf "$SNAPSHOT"' EXIT
log "snapshotting DB from $DATA_DIR to $SNAPSHOT"
for f in "$DB" "$DB-wal" "$DB-shm"; do
  [[ -f "$DATA_DIR/$f" ]] && cp -a "$DATA_DIR/$f" "$SNAPSHOT/" || true
done

rollback() {
  local reason=$1 ok=true
  log "rolling back: $reason"
  systemctl --user stop para-raid || true
  for f in "$DB" "$DB-wal" "$DB-shm"; do
    if [[ -f "$SNAPSHOT/$f" ]]; then
      cp -a "$SNAPSHOT/$f" "$DATA_DIR/" || { log "warning: DB restore of $f failed"; ok=false; }
    else
      rm -f "$DATA_DIR/$f" || { log "warning: rm of stale $f failed"; ok=false; }
    fi
  done
  # reset --hard, not checkout: checkout of a raw SHA detaches HEAD and every
  # future `git pull --ff-only` fails until someone reattaches the branch.
  git -C "$REPO" reset --hard "$PREV" >> "$LOG" 2>&1 || { log "warning: git reset --hard $PREV failed"; ok=false; }
  bun install --frozen-lockfile --cwd "$REPO" >> "$LOG" 2>&1 || { log "warning: rollback bun install failed"; ok=false; }
  systemctl --user start para-raid || { log "warning: rollback start failed"; ok=false; }
  if $ok && systemctl --user is-active --quiet para-raid; then
    notify "para-raid update rolled back OK: $reason"
  else
    notify "para-raid update FAILED and ROLLBACK ALSO FAILED — daemon may be down: $reason"
  fi
}

log "pulling $REMOTE"
if ! git -C "$REPO" pull --ff-only >> "$LOG" 2>&1; then
  rollback "git pull --ff-only failed"
  exit 2
fi

log "bun install"
if ! bun install --frozen-lockfile --cwd "$REPO" >> "$LOG" 2>&1; then
  rollback "bun install failed"
  exit 2
fi

log "typecheck (bunx tsc --noEmit)"
if ! ( cd "$REPO" && bunx tsc --noEmit ) >> "$LOG" 2>&1; then
  rollback "tsc --noEmit failed"
  exit 2
fi

log "starting para-raid"
if ! systemctl --user start para-raid >> "$LOG" 2>&1; then
  rollback "systemctl start failed"
  exit 1
fi

# Healthcheck: `para-raid status` succeeding is the gate. Deliberately NOT
# `para-raid doctor` — doctor also checks claude subscription auth, and a
# lapsed login would false-negative an otherwise-good deploy.
log "healthchecking via 'para-raid status' (up to 30s)"
healthy=false
for i in $(seq 1 15); do
  if para-raid status >> "$LOG" 2>&1; then
    healthy=true
    log "healthcheck OK on attempt $i"
    break
  fi
  sleep 2
done

if ! $healthy; then
  log "healthcheck FAILED after 30s"
  rollback "para-raid status did not succeed within 30s"
  exit 1
fi

log "=== update-para-raid done (HEAD=$REMOTE) ==="
