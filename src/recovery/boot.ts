import type { Db } from "../db";
import type { EventBus } from "../events/bus";
import type { TmuxAdapter } from "../tmux/adapter";
import type { Logger } from "../logger";
import type { ParaRaidConfig } from "../types";
import { cleanupWorkdir } from "../workdir";
import { enqueueWebhook } from "../publisher/enqueue";

export interface BootCtx {
  db: Db;
  bus: EventBus;
  tmux: TmuxAdapter;
  config: ParaRaidConfig;
  logger: Logger;
}

interface ActiveSessionRow {
  id: string;
  adapter_id: string;
  webhook_url: string;
  tmux_session: string;
  cwd: string;
}

/**
 * Boot reconciliation: synchronous pass over `live`/`launching` sessions
 * before the API serves traffic. Tier-0 tmux+pane probe decides each row:
 *   pass → flip to `recovering` with `recovery_expires_at = now + grace_window_ms`,
 *          enqueue `session_recover_candidate`. Adapter must opt in via
 *          POST /v1/resume_session within the window.
 *   fail → flip to `dead`, cleanup workdir, enqueue `session_dead`
 *          with reason `tmux_gone_at_boot`.
 *
 * Plan-defect note: the master plan's snippet writes `closed_at = ?` but the
 * frozen schema has no `closed_at` column. We update `updated_at` instead.
 */
export async function reconcileOnBoot(
  ctx: BootCtx,
): Promise<{ recovering: number; dead: number }> {
  const rows = ctx.db.raw
    .query<ActiveSessionRow, []>(
      `SELECT id, adapter_id, webhook_url, tmux_session, cwd
       FROM sessions WHERE status IN ('live','launching')`,
    )
    .all();

  let recovering = 0;
  let dead = 0;

  for (const sess of rows) {
    const tmuxAlive = await ctx.tmux.hasSession(sess.tmux_session);
    const pid = tmuxAlive ? await ctx.tmux.listPanePid(sess.tmux_session) : null;
    const tier0Pass = tmuxAlive && pid !== null;

    const now = Date.now();
    if (tier0Pass) {
      const expiresAt = now + ctx.config.recovery.grace_window_ms;
      ctx.db.raw.run(
        `UPDATE sessions SET status = 'recovering', recovery_expires_at = ?, updated_at = ? WHERE id = ?`,
        [expiresAt, now, sess.id],
      );
      enqueueWebhook(ctx.db, {
        eventType: "session_recover_candidate",
        sessionId: sess.id,
        adapterId: sess.adapter_id,
        webhookUrl: sess.webhook_url,
        payload: { recovery_expires_at: expiresAt },
      });
      ctx.logger.info("recovery.boot.candidate", {
        session_id: sess.id,
        expires_at: expiresAt,
      });
      recovering++;
    } else {
      ctx.db.raw.run(
        `UPDATE sessions SET status = 'dead', updated_at = ? WHERE id = ?`,
        [now, sess.id],
      );
      try {
        cleanupWorkdir(sess.cwd);
      } catch {
        // best-effort: workdir may already be gone
      }
      enqueueWebhook(ctx.db, {
        eventType: "session_dead",
        sessionId: sess.id,
        adapterId: sess.adapter_id,
        webhookUrl: sess.webhook_url,
        payload: { reason: "tmux_gone_at_boot" },
      });
      ctx.logger.warn("recovery.boot.dead", { session_id: sess.id });
      dead++;
    }
  }

  return { recovering, dead };
}
