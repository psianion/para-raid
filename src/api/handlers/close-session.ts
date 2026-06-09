import { z } from "zod";
import { randomUUID } from "crypto";
import { closeSession } from "../../sessions/closer";
import type { Handler } from "../router";
import { jsonResponse, errorResponse } from "../envelope";
import type { WebhookEventType } from "../../types";

const Req = z.object({ session_id: z.string().uuid() });

export const closeSessionHandler: Handler = async (req, ctx) => {
  const parsed = Req.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_request", parsed.error.message, ctx.requestId);
  const sess = ctx.db.raw.query<{ tmux_session: string; cwd: string; webhook_url: string; adapter_id: string }, [string]>(
    "SELECT tmux_session, cwd, webhook_url, adapter_id FROM sessions WHERE id = ? AND status IN ('live','launching','recovering')"
  ).get(parsed.data.session_id) as any;
  if (!sess) return errorResponse(404, "not_found", "no live session with that id", ctx.requestId);

  // Async close; respond immediately
  (async () => {
    try {
      await closeSession({ tmux: ctx.tmux, bus: ctx.bus, sessionId: parsed.data.session_id, tmuxName: sess.tmux_session, workdir: sess.cwd, timeoutMs: 10_000 });
      // Bounded poll for tmux teardown (Wave 3-4 lesson #2).
      for (let i = 0; i < 10; i++) {
        if (!(await ctx.tmux.hasSession(sess.tmux_session))) break;
        await new Promise(r => setTimeout(r, 200));
      }
      ctx.db.raw.run("UPDATE sessions SET status = 'closed', updated_at = ? WHERE id = ?", [Date.now(), parsed.data.session_id]);
      const eventType: WebhookEventType = "session_closed";
      ctx.db.raw.run(
        `INSERT INTO webhook_queue (event_id, session_id, adapter_id, event_type, payload_json, webhook_url, status, attempt_count, next_attempt_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [randomUUID(), parsed.data.session_id, sess.adapter_id, eventType, JSON.stringify({ event_type: eventType, session_id: parsed.data.session_id }), sess.webhook_url, "pending", 0, Date.now(), Date.now()]
      );
    } catch (err) {
      ctx.logger.error("close_session.async_failed", { session_id: parsed.data.session_id, error: String(err) });
    }
  })();
  return jsonResponse(200, { session_id: parsed.data.session_id, status: "closing" });
};
