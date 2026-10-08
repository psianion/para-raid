import { rmSync } from "fs";
import type { Db } from "../db";
import type { WorkerRuntime } from "../worker/runtime";
import type { Logger } from "../logger";
import { enqueueWebhook } from "../publisher/enqueue";

export interface WatchdogCtx {
  db: Db;
  runtime: WorkerRuntime;
  logger: Logger;
}

export interface Watchdog {
  stop: () => void;
}

// ponytail: matches recovery.grace_window_ms; upgrade path = per-session turn_timeout config.
const STALE_TURN_THRESHOLD_MS = 10 * 60_000;

interface LiveSessionRow {
  id: string;
  adapter_id: string;
  webhook_url: string;
  cwd: string;
}

/**
 * Tier-0 health probe over all `live` sessions.
 *
 * Detects a worker that died outside the daemon's control (OOM-killer, crash,
 * a stray kill). For each session with no live worker process, flips the row
 * to `dead`, removes the workdir, and enqueues a `session_dead` webhook with
 * reason `external_kill`.
 *
 * Tier-1 (hung-but-alive): for sessions that pass tier-0, a turn stuck in
 * `dispatching` past STALE_TURN_THRESHOLD_MS is reaped via the same path with
 * reason `stuck_turn` so adapters can tell it apart from `external_kill`.
 */
function reap(
  ctx: WatchdogCtx,
  sess: LiveSessionRow,
  reason: "external_kill" | "stuck_turn"
): void {
  ctx.db.raw.run(
    "UPDATE sessions SET status = 'dead', updated_at = ? WHERE id = ?",
    [Date.now(), sess.id]
  );
  // A hung worker is still a process: don't leave it running after we've
  // declared the session dead.
  ctx.runtime.get(sess.id)?.kill("SIGTERM");
  try {
    rmSync(sess.cwd, { recursive: true, force: true });
  } catch {
    // workdir cleanup is best-effort
  }
  enqueueWebhook(ctx.db, {
    eventType: "session_dead",
    sessionId: sess.id,
    adapterId: sess.adapter_id,
    webhookUrl: sess.webhook_url,
    payload: { reason },
  });
  ctx.logger.warn("watchdog.dead", {
    session_id: sess.id,
    reason,
  });
}

export async function watchdogTick(ctx: WatchdogCtx): Promise<void> {
  const live = ctx.db.raw
    .query<LiveSessionRow, []>(
      "SELECT id, adapter_id, webhook_url, cwd FROM sessions WHERE status = 'live'"
    )
    .all();

  for (const sess of live) {
    const handle = ctx.runtime.get(sess.id);
    if (!handle || !handle.alive) {
      reap(ctx, sess, "external_kill"); // tier-0 fail
      continue;
    }

    // Tier-1: alive but a turn is stuck mid-dispatch with no progress.
    const stuck = ctx.db.raw
      .query<{ id: string }, [string, number]>(
        `SELECT id FROM turns
          WHERE session_id = ? AND status = 'dispatching' AND completed_at IS NULL
            AND COALESCE(dispatched_at, created_at) < ?
          LIMIT 1`
      )
      .get(sess.id, Date.now() - STALE_TURN_THRESHOLD_MS);
    if (stuck) reap(ctx, sess, "stuck_turn");
  }
}

export function startWatchdog(ctx: WatchdogCtx, intervalMs = 30_000): Watchdog {
  const interval = setInterval(() => {
    watchdogTick(ctx).catch((err) =>
      ctx.logger.error("watchdog.tick_error", { error: String(err) })
    );
  }, intervalMs);
  return {
    stop: () => clearInterval(interval),
  };
}
