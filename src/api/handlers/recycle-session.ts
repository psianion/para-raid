import { z } from "zod";
import { recycleSession } from "../../sessions/recycler";
import type { Handler } from "../router";
import { jsonResponse, errorResponse } from "../envelope";
import { enqueueWebhook } from "../../publisher/enqueue";

const Req = z.object({ session_id: z.string().uuid() });

export const recycleSessionHandler: Handler = async (req, ctx) => {
  const parsed = Req.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(400, "invalid_request", parsed.error.message, ctx.requestId);
  const sess = ctx.db.raw.query<{ adapter_id: string; adapter_ref: string; tmux_session: string; cwd: string; webhook_url: string; mcp_bundle: string }, [string]>(
    "SELECT adapter_id, adapter_ref, tmux_session, cwd, webhook_url, mcp_bundle FROM sessions WHERE id = ? AND status = 'live'"
  ).get(parsed.data.session_id) as any;
  if (!sess) return errorResponse(404, "session_not_live", "no live session with that id", ctx.requestId);

  if (!ctx.hookEventsPath) {
    ctx.logger.error("recycle_session.no_hook_path", { session_id: parsed.data.session_id });
    return errorResponse(500, "internal", "hookEventsPath missing — daemon misconfigured", ctx.requestId);
  }

  const newId = await recycleSession({
    tmux: ctx.tmux, bus: ctx.bus,
    oldSessionId: parsed.data.session_id, tmuxName: sess.tmux_session, cwd: sess.cwd, timeoutMs: 30_000,
    hookEventsPath: ctx.hookEventsPath,           // REQUIRED at runtime per Wave 3-4 lesson #3
  });

  ctx.db.transaction(() => {
    const now = Date.now();
    ctx.db.raw.run("UPDATE sessions SET status = 'closed', updated_at = ? WHERE id = ?", [now, parsed.data.session_id]);
    ctx.db.raw.run(
      `INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [newId, sess.adapter_id, sess.adapter_ref, "live", sess.tmux_session, sess.cwd, sess.mcp_bundle, sess.webhook_url, now, now]
    );
    enqueueWebhook(ctx.db, {
      eventType: "session_recycled",
      sessionId: newId,
      adapterId: sess.adapter_id,
      webhookUrl: sess.webhook_url,
      payload: { old_session_id: parsed.data.session_id, new_session_id: newId },
    });
  });
  return jsonResponse(202, { old_session_id: parsed.data.session_id, new_session_id: newId });
};
