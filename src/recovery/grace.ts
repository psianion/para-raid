import type { BootCtx } from "./boot";
import { cleanupWorkdir } from "../workdir";
import { enqueueWebhook } from "../publisher/enqueue";

export interface GraceTimer {
  stop: () => void;
}

interface ExpiredRow {
  id: string;
  adapter_id: string;
  webhook_url: string;
  cwd: string;
}

/**
 * Periodic sweep that flips `recovering` rows whose `recovery_expires_at` has
 * passed into `dead`, cleans the workdir, and enqueues a `session_dead`
 * webhook with reason `grace_expired`. Returns a handle so the daemon can
 * stop it cleanly on shutdown.
 *
 * Default cadence is 60s per the master plan; tests can pass a smaller
 * intervalMs and call `tick` directly via the returned reference is not
 * exposed — instead tests INSERT an expired row, then await a single tick
 * by setting a tiny intervalMs and yielding.
 *
 * Plan-defect note: the master plan's snippet writes `closed_at = ?` but the
 * frozen schema has no `closed_at` column. We update `updated_at` instead.
 * Comparison uses `<=` per the executor brief (plan §6 specifies the same
 * semantics; `<` would skip a row that expired exactly on the tick boundary).
 */
export function startGraceTimer(ctx: BootCtx, intervalMs = 60_000): GraceTimer {
  const tick = (): void => {
    const now = Date.now();
    const expired = ctx.db.raw
      .query<ExpiredRow, [number]>(
        `SELECT id, adapter_id, webhook_url, cwd
         FROM sessions
         WHERE status = 'recovering' AND recovery_expires_at <= ?`,
      )
      .all(now);

    for (const sess of expired) {
      ctx.db.raw.run(
        `UPDATE sessions SET status = 'dead', updated_at = ? WHERE id = ?`,
        [now, sess.id],
      );
      try {
        cleanupWorkdir(sess.cwd);
      } catch {
        // best-effort
      }
      enqueueWebhook(ctx.db, {
        eventType: "session_dead",
        sessionId: sess.id,
        adapterId: sess.adapter_id,
        webhookUrl: sess.webhook_url,
        payload: { reason: "grace_expired" },
      });
      ctx.logger.warn("recovery.grace.expired", { session_id: sess.id });
    }
  };

  const interval = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(interval) };
}
