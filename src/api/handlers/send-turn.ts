import { z } from "zod";
import { randomUUID, createHash } from "crypto";
import { assertOwnership, type Handler } from "../router";
import { jsonResponse, errorResponse } from "../envelope";
import { enqueueWebhook } from "../../publisher/enqueue";

const Req = z.object({
  session_id: z.string().uuid(),
  prompt: z.string().min(1),
});

export const sendTurnHandler: Handler = async (req, ctx) => {
  const body = await req.json().catch(() => null);
  const parsed = Req.safeParse(body);
  if (!parsed.success) return errorResponse(400, "invalid_request", parsed.error.message, ctx.requestId);
  const data = parsed.data;

  if (ctx.modeController.isPaused()) return errorResponse(503, "paused", "daemon is paused", ctx.requestId);

  const sess = ctx.db.raw.query<
    { adapter_id: string; cwd: string; webhook_url: string },
    [string]
  >(
    "SELECT adapter_id, cwd, webhook_url FROM sessions WHERE id = ? AND status = 'live'",
  ).get(data.session_id) as { adapter_id: string; cwd: string; webhook_url: string } | null;
  if (!sess) return errorResponse(404, "session_not_live", "no live session with that id", ctx.requestId);
  assertOwnership(ctx, sess.adapter_id);

  const turnId = randomUUID();
  const promptSha256 = createHash("sha256").update(data.prompt).digest("hex");
  const now = Date.now();

  ctx.db.transaction(() => {
    ctx.db.raw.run(
      `INSERT INTO turns (id, session_id, status, prompt_sha256, created_at) VALUES (?,?,?,?,?)`,
      [turnId, data.session_id, "queued", promptSha256, now],
    );
    ctx.db.raw.run(
      "UPDATE sessions SET last_turn_at = ?, updated_at = ? WHERE id = ?",
      [now, now, data.session_id],
    );
  });

  // Async: dispatch + reply (fire-and-forget). The runner resolves with the
  // result event's text, falling back to the worker's accumulated assistant
  // text when claude leaves `result` empty.
  (async () => {
    try {
      ctx.db.raw.run(
        "UPDATE turns SET status = 'dispatching', dispatched_at = ? WHERE id = ?",
        [Date.now(), turnId],
      );
      const reply = await ctx.dispatcher.enqueue({
        session_id: data.session_id,
        turn_id: turnId,
        prompt: data.prompt,
      });

      ctx.db.raw.run(
        "UPDATE turns SET status = 'completed', completed_at = ? WHERE id = ?",
        [Date.now(), turnId],
      );
      enqueueWebhook(ctx.db, {
        eventType: "turn_replied",
        sessionId: data.session_id,
        adapterId: sess.adapter_id,
        webhookUrl: sess.webhook_url,
        payload: { session_id: data.session_id, turn_id: turnId, reply: reply ?? "" },
      });
    } catch (err) {
      ctx.logger.error("send_turn.async_failed", { session_id: data.session_id, turn_id: turnId, error: String(err) });
      ctx.db.raw.run(
        "UPDATE turns SET status = 'failed', completed_at = ?, error = ? WHERE id = ? AND status NOT IN ('completed','cancelled')",
        [Date.now(), String(err), turnId],
      );
      enqueueWebhook(ctx.db, {
        eventType: "turn_failed",
        sessionId: data.session_id,
        adapterId: sess.adapter_id,
        webhookUrl: sess.webhook_url,
        payload: { session_id: data.session_id, turn_id: turnId, error: String(err) },
      });
    }
  })();

  return jsonResponse(202, { session_id: data.session_id, turn_id: turnId, status: "dispatching" });
};
