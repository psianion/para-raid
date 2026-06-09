import { z } from "zod";
import { randomUUID } from "crypto";
import type { Handler, HandlerCtx } from "../router";
import { jsonResponse, errorResponse } from "../envelope";

const Req = z.object({}).optional();

function enqueueModeWebhooks(ctx: HandlerCtx, eventType: "paused" | "resumed"): void {
  const adapters = ctx.config.adapters ?? {};
  const now = Date.now();
  for (const [adapterId, cfg] of Object.entries(adapters)) {
    const url = (cfg as { webhook_url: string }).webhook_url;
    if (!url) continue;
    ctx.db.raw.run(
      `INSERT INTO webhook_queue (event_id, session_id, adapter_id, event_type, payload_json, webhook_url, status, attempt_count, next_attempt_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [randomUUID(), null, adapterId, eventType, JSON.stringify({ event_type: eventType, session_id: null, mode: eventType === "paused" ? "paused" : "running", at: now }), url, "pending", 0, now, now],
    );
  }
}

export const pauseHandler: Handler = async (req, ctx) => {
  const body = await req.json().catch(() => ({}));
  const parsed = Req.safeParse(body);
  if (!parsed.success) return errorResponse(400, "invalid_request", parsed.error.message, ctx.requestId);

  const wasPaused = ctx.modeController.isPaused();
  ctx.modeController.pause();
  if (!wasPaused) enqueueModeWebhooks(ctx, "paused");

  return jsonResponse(200, { mode: "paused" });
};
