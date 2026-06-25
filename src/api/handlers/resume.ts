import { z } from "zod";
import { assertAdmin, type Handler } from "../router";
import { jsonResponse, errorResponse } from "../envelope";
import { enqueueModeWebhooks } from "../../publisher/enqueue";

const Req = z.object({}).optional();

export const resumeHandler: Handler = async (req, ctx) => {
  assertAdmin(ctx);
  const body = await req.json().catch(() => ({}));
  const parsed = Req.safeParse(body);
  if (!parsed.success) return errorResponse(400, "invalid_request", parsed.error.message, ctx.requestId);

  const wasPaused = ctx.modeController.isPaused();
  ctx.modeController.resume();
  if (wasPaused) enqueueModeWebhooks(ctx.db, ctx.config.adapters ?? {}, "resumed");

  return jsonResponse(200, { mode: "running" });
};
