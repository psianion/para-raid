import { rmSync } from "fs";
import type { Db } from "../db";
import type { TmuxAdapter } from "../tmux/adapter";
import type { Logger } from "../logger";
import { enqueueWebhook } from "../publisher/enqueue";

export interface WatchdogCtx {
  db: Db;
  tmux: TmuxAdapter;
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
  tmux_session: string;
  cwd: string;
}

/**
 * Tier-0 health probe over all `live` sessions.
 *
 * Detects external tmux kill (e.g. `tmux kill-session`, OOM-killer, host crash).
 * For each session whose tmux pane is gone OR whose pane PID cannot be read,
 * flips the row to `dead`, removes the workdir, and enqueues a `session_dead`
 * webhook with reason `external_kill`.
 *
 * Tier-1 (hung-but-alive): for sessions that pass tier-0, a turn stuck in
 * `dispatching` past STALE_TURN_THRESHOLD_MS is reaped via the same path with
 * reason `stuck_turn` so adapters can tell it apart from `external_kill`. No
 * transcript scan — the stale timestamp IS the lack-of-progress signal.
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
    tmux: sess.tmux_session,
    reason,
  });
}

export async function watchdogTick(ctx: WatchdogCtx): Promise<void> {
  const live = ctx.db.raw
    .query<LiveSessionRow, []>(
      "SELECT id, adapter_id, webhook_url, tmux_session, cwd FROM sessions WHERE status = 'live'"
    )
    .all();

  for (const sess of live) {
    const tmuxAlive = await ctx.tmux.hasSession(sess.tmux_session);
    const pid = tmuxAlive ? await ctx.tmux.listPanePid(sess.tmux_session) : null;
    if (!tmuxAlive || pid === null) {
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
