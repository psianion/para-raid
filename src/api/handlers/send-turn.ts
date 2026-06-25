import { z } from "zod";
import { randomUUID, createHash } from "crypto";
import { assertOwnership, type Handler } from "../router";
import { jsonResponse, errorResponse } from "../envelope";
import { enqueueWebhook } from "../../publisher/enqueue";
import { getLastAssistantText } from "../../transcript/reader";
import { findTranscriptForCwd } from "../../transcript/locator";
import type { HookEvent } from "../../types";

const Req = z.object({
  session_id: z.string().uuid(),
  prompt: z.string().min(1),
});

/**
 * Wave 3-4 lesson #1: Stop's `last_assistant_message` may be empty for very
 * short replies AND `getLastAssistantText` may briefly return null right
 * after Stop because claude buffers transcript writes. Try the Stop
 * payload first, then poll the transcript for up to ~5 s before failing.
 */
async function pollTranscriptForReply(cwd: string, attempts = 25, intervalMs = 200): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    const t = findTranscriptForCwd(cwd);
    if (t) {
      const text = getLastAssistantText(t);
      if (text) return text;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

export const sendTurnHandler: Handler = async (req, ctx) => {
  const body = await req.json().catch(() => null);
  const parsed = Req.safeParse(body);
  if (!parsed.success) return errorResponse(400, "invalid_request", parsed.error.message, ctx.requestId);
  const data = parsed.data;

  if (ctx.modeController.isPaused()) return errorResponse(503, "paused", "daemon is paused", ctx.requestId);

  const sess = ctx.db.raw.query<
    { adapter_id: string; tmux_session: string; cwd: string; webhook_url: string },
    [string]
  >(
    "SELECT adapter_id, tmux_session, cwd, webhook_url FROM sessions WHERE id = ? AND status = 'live'",
  ).get(data.session_id) as { adapter_id: string; tmux_session: string; cwd: string; webhook_url: string } | null;
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

  // Subscribe to the bus BEFORE dispatching so we don't miss the Stop event.
  let lastAssistantFromStop: string | null = null;
  const stopHandler = (e: HookEvent) => {
    if (e.hook_event_name === "Stop" && e.session_id === data.session_id) {
      const m = (e as any).last_assistant_message;
      if (typeof m === "string" && m.length > 0) lastAssistantFromStop = m;
    }
  };
  ctx.bus.subscribe(stopHandler);

  // Async: dispatch + reply extraction (fire-and-forget)
  (async () => {
    try {
      ctx.db.raw.run(
        "UPDATE turns SET status = 'dispatching', dispatched_at = ? WHERE id = ?",
        [Date.now(), turnId],
      );
      const dispatcherReply = await ctx.dispatcher.enqueue({
        session_id: data.session_id,
        turn_id: turnId,
        prompt: data.prompt,
        tmux_session: sess.tmux_session,
      });

      // Reply preference order (Wave 3-4 lesson #1):
      //   1. dispatcher's onDispatch return value (the production wiring puts
      //      Stop's last_assistant_message + transcript poll there)
      //   2. Stop event's last_assistant_message captured on the bus
      //   3. bounded transcript poll on the session's cwd
      let reply: string | null = dispatcherReply && dispatcherReply.length > 0 ? dispatcherReply : null;
      if (!reply) reply = lastAssistantFromStop;
      if (!reply) reply = await pollTranscriptForReply(sess.cwd);

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
        "UPDATE turns SET status = 'failed', completed_at = ?, error = ? WHERE id = ?",
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
