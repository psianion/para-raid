import { z } from "zod";
import type { Handler } from "../router";
import { jsonResponse, errorResponse } from "../envelope";
import { enqueueModeWebhooks } from "../../publisher/enqueue";

const Req = z.object({}).optional();

export const pauseHandler: Handler = async (req, ctx) => {
  const body = await req.json().catch(() => ({}));
  const parsed = Req.safeParse(body);
  if (!parsed.success) return errorResponse(400, "invalid_request", parsed.error.message, ctx.requestId);

  const wasPaused = ctx.modeController.isPaused();
  ctx.modeController.pause();
  if (!wasPaused) enqueueModeWebhooks(ctx.db, ctx.config.adapters ?? {}, "paused");

  return jsonResponse(200, { mode: "paused" });
};
