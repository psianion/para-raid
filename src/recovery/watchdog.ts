import { rmSync } from "fs";
import { randomUUID } from "crypto";
import type { Db } from "../db";
import type { TmuxAdapter } from "../tmux/adapter";
import type { Logger } from "../logger";
import type { WebhookEventType } from "../types";

export interface WatchdogCtx {
  db: Db;
  tmux: TmuxAdapter;
  logger: Logger;
}

export interface Watchdog {
  stop: () => void;
}

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
 * TODO(wave-7): tier-1 transcript scan when tier-0 says alive but session has
 *               been awaiting_stop > 10 min.
 */
export async function watchdogTick(ctx: WatchdogCtx): Promise<void> {
  const live = ctx.db.raw
    .query<LiveSessionRow, []>(
      "SELECT id, adapter_id, webhook_url, tmux_session, cwd FROM sessions WHERE status = 'live'"
    )
    .all();

  for (const sess of live) {
    const tmuxAlive = await ctx.tmux.hasSession(sess.tmux_session);
    const pid = tmuxAlive ? await ctx.tmux.listPanePid(sess.tmux_session) : null;
    if (tmuxAlive && pid !== null) continue; // healthy

    // Tier-0 fail → mark dead.
    const now = Date.now();
    ctx.db.raw.run(
      "UPDATE sessions SET status = 'dead', updated_at = ? WHERE id = ?",
      [now, sess.id]
    );
    try {
      rmSync(sess.cwd, { recursive: true, force: true });
    } catch {
      // workdir cleanup is best-effort
    }
    ctx.db.raw.run(
      `INSERT INTO webhook_queue
         (event_id, session_id, adapter_id, event_type, payload_json, webhook_url, status, attempt_count, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        sess.id,
        sess.adapter_id,
        ("session_dead" satisfies WebhookEventType),
        JSON.stringify({ event_type: "session_dead", session_id: sess.id, reason: "external_kill" }),
        sess.webhook_url,
        "pending",
        0,
        now,
        now,
      ]
    );
    ctx.logger.warn("watchdog.dead", {
      session_id: sess.id,
      tmux: sess.tmux_session,
      reason: "external_kill",
    });
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
