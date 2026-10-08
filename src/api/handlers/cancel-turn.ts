import { z } from "zod";
import { cancelTurn } from "../../sessions/cancel";
import { assertOwnership, type Handler } from "../router";
import { jsonResponse, errorResponse } from "../envelope";
import { enqueueWebhook } from "../../publisher/enqueue";

const Req = z.object({
  session_id: z.string().uuid(),
  turn_id: z.string().uuid().optional(),
});

export const cancelTurnHandler: Handler = async (req, ctx) => {
  const body = await req.json().catch(() => null);
  const parsed = Req.safeParse(body);
  if (!parsed.success) return errorResponse(400, "invalid_request", parsed.error.message, ctx.requestId);
  const data = parsed.data;

  const sess = ctx.db.raw.query<
    { adapter_id: string; cwd: string; webhook_url: string },
    [string]
  >(
    "SELECT adapter_id, cwd, webhook_url FROM sessions WHERE id = ? AND status = 'live'",
  ).get(data.session_id) as { adapter_id: string; cwd: string; webhook_url: string } | null;
  if (!sess) return errorResponse(404, "session_not_live", "no live session with that id", ctx.requestId);
  assertOwnership(ctx, sess.adapter_id);

  const result = await cancelTurn({
    runtime: ctx.runtime,
    bus: ctx.bus,
    sessionId: data.session_id,
  });

  // Mark turn cancelled if the caller specified one and it's still live.
  if (data.turn_id) {
    ctx.db.raw.run(
      "UPDATE turns SET status = 'cancelled', completed_at = ? WHERE id = ? AND status NOT IN ('completed','cancelled','failed')",
      [Date.now(), data.turn_id],
    );
  }

  const payload = {
    session_id: data.session_id,
    turn_id: data.turn_id ?? null,
    cancelled: result.cancelled,
    escalated_to_signal: result.escalatedToSignal,
    partial_text: result.partialText,
  };
  enqueueWebhook(ctx.db, {
    eventType: "turn_cancelled",
    sessionId: data.session_id,
    adapterId: sess.adapter_id,
    webhookUrl: sess.webhook_url,
    payload,
  });

  return jsonResponse(200, {
    cancelled: result.cancelled,
    escalated_to_signal: result.escalatedToSignal,
    partial_text: result.partialText,
  });
};
