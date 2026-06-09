import type { Handler } from "../router";
import { jsonResponse } from "../envelope";

interface StatusRow { status: string; n: number }

export const statusHandler: Handler = async (_req, ctx) => {
  const rows = ctx.db.raw.query<StatusRow, []>(
    "SELECT status, COUNT(*) AS n FROM sessions GROUP BY status",
  ).all() as StatusRow[];

  const counts: Record<string, number> = { live: 0, launching: 0, recovering: 0, closed: 0, dead: 0 };
  for (const r of rows) {
    if (r.status in counts) counts[r.status] = r.n;
  }

  const ramMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 100) / 100;

  return jsonResponse(200, {
    mode: ctx.modeController.mode(),
    active_turns: ctx.dispatcher.activeCount,
    pending_turns: ctx.dispatcher.pendingCount,
    sessions: counts,
    ram_mb: ramMb,
  });
};
