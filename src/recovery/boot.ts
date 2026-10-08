import { existsSync } from "fs";
import type { Db } from "../db";
import type { EventBus } from "../events/bus";
import type { WorkerRuntime } from "../worker/runtime";
import type { Logger } from "../logger";
import type { ParaRaidConfig } from "../types";
import { cleanupWorkdir } from "../workdir";
import { enqueueWebhook } from "../publisher/enqueue";

export interface BootCtx {
  db: Db;
  bus: EventBus;
  runtime: WorkerRuntime;
  config: ParaRaidConfig;
  logger: Logger;
}

interface ActiveSessionRow {
  id: string;
  adapter_id: string;
  webhook_url: string;
  cwd: string;
}

/**
 * Boot reconciliation: synchronous pass over `live`/`launching` sessions
 * before the API serves traffic. Workers are children of the daemon, so none
 * survive a restart — but claude persists every conversation to disk and
 * `--resume` brings it back. Each row therefore becomes a recovery candidate:
 *   workdir present → flip to `recovering` with `recovery_expires_at = now +
 *          grace_window_ms`, enqueue `session_recover_candidate`. The adapter
 *          opts in via POST /v1/resume_session within the window and the
 *          daemon relaunches the worker with `--resume`.
 *   workdir gone    → flip to `dead`, enqueue `session_dead` with reason
 *          `workdir_gone_at_boot`.
 */
export async function reconcileOnBoot(
  ctx: BootCtx,
): Promise<{ recovering: number; dead: number }> {
  const rows = ctx.db.raw
    .query<ActiveSessionRow, []>(
      `SELECT id, adapter_id, webhook_url, cwd
       FROM sessions WHERE status IN ('live','launching')`,
    )
    .all();

  let recovering = 0;
  let dead = 0;

  for (const sess of rows) {
    const now = Date.now();
    if (existsSync(sess.cwd)) {
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
        payload: { reason: "workdir_gone_at_boot" },
      });
      ctx.logger.warn("recovery.boot.dead", { session_id: sess.id });
      dead++;
    }
  }

  return { recovering, dead };
}
