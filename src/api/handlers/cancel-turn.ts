import { z } from "zod";
import { randomUUID } from "crypto";
import { cancelTurn } from "../../sessions/cancel";
import { findTranscriptForCwd } from "../../transcript/locator";
import type { Handler, HandlerCtx } from "../router";
import { jsonResponse, errorResponse } from "../envelope";
import type { WebhookEventType } from "../../types";

const Req = z.object({
  session_id: z.string().uuid(),
  turn_id: z.string().uuid().optional(),
});

function enqueueWebhook(
  ctx: HandlerCtx,
  eventType: WebhookEventType,
  sessionId: string,
  payload: Record<string, unknown>,
  webhookUrl: string,
  adapterId: string,
) {
  ctx.db.raw.run(
    `INSERT INTO webhook_queue (event_id, session_id, adapter_id, event_type, payload_json, webhook_url, status, attempt_count, next_attempt_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [randomUUID(), sessionId, adapterId, eventType, JSON.stringify({ event_type: eventType, session_id: sessionId, ...payload }), webhookUrl, "pending", 0, Date.now(), Date.now()],
  );
}

export const cancelTurnHandler: Handler = async (req, ctx) => {
  const body = await req.json().catch(() => null);
  const parsed = Req.safeParse(body);
  if (!parsed.success) return errorResponse(400, "invalid_request", parsed.error.message, ctx.requestId);
  const data = parsed.data;

  const sess = ctx.db.raw.query<
    { adapter_id: string; tmux_session: string; cwd: string; webhook_url: string },
    [string]
  >(
    "SELECT adapter_id, tmux_session, cwd, webhook_url FROM sessions WHERE id = ? AND status = 'live'",
  ).get(data.session_id) as { adapter_id: string; tmux_session: string; cwd: string; webhook_url: string } | null;
  if (!sess) return errorResponse(404, "session_not_live", "no live session with that id", ctx.requestId);

  // Look up transcript via the same encoded-cwd helper the smoke uses.
  // findTranscriptForCwd may return null (no transcript file yet); cancelTurn
  // tolerates a missing path (getLastAssistantText returns null).
  const transcriptPath = findTranscriptForCwd(sess.cwd) ?? `${sess.cwd}/.no-transcript.jsonl`;

  const result = await cancelTurn({
    tmux: ctx.tmux,
    bus: ctx.bus,
    sessionId: data.session_id,
    tmuxName: sess.tmux_session,
    transcriptPath,
  });

  // Mark turn cancelled if the caller specified one and it's still live.
  if (data.turn_id) {
    ctx.db.raw.run(
      "UPDATE turns SET status = 'cancelled', completed_at = ? WHERE id = ? AND status NOT IN ('completed','cancelled','failed')",
      [Date.now(), data.turn_id],
    );
  }

  enqueueWebhook(
    ctx,
    "turn_cancelled",
    data.session_id,
    {
      session_id: data.session_id,
      turn_id: data.turn_id ?? null,
      cancelled: result.cancelled,
      escalated_to_ctrl_c: result.escalatedToCtrlC,
      partial_text: result.partialText,
    },
    sess.webhook_url,
    sess.adapter_id,
  );

  return jsonResponse(200, {
    cancelled: result.cancelled,
    escalated_to_ctrl_c: result.escalatedToCtrlC,
    partial_text: result.partialText,
  });
};
