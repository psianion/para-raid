import { z } from "zod";
import { existsSync } from "fs";
import { join } from "path";
import { launchSession } from "../../sessions/launcher";
import { assertOwnership, type Handler } from "../router";
import { jsonResponse, errorResponse } from "../envelope";
import { enqueueWebhook } from "../../publisher/enqueue";

const Req = z.object({
  session_id: z.string().uuid(),
});

// Test seam: the backoff between resume attempts (tests shrink it).
export const __resumeHooks: { backoffMs: number; launchGraceMs: number | undefined } = {
  backoffMs: 5_000,
  launchGraceMs: undefined,
};

// In-flight resume claims. Two deliveries of the same recover-candidate can
// both pass the status='recovering' SQL guard (the first only flips status
// AFTER its launch finishes); the loser would then double-spawn a worker for
// the same conversation. Single daemon process, so a synchronous Set claim is
// atomic.
const resuming = new Set<string>();

/**
 * Relaunch a recovering session's worker with `claude --resume <session_id>`
 * — claude persisted the conversation, so the new process picks up with full
 * context. 3 attempts with backoff, synchronous inside the request so the
 * caller learns the outcome.
 */
export const resumeSessionHandler: Handler = async (req, ctx) => {
  const body = await req.json().catch(() => null);
  const parsed = Req.safeParse(body);
  if (!parsed.success) return errorResponse(400, "invalid_request", parsed.error.message, ctx.requestId);
  const data = parsed.data;

  const sess = ctx.db.raw.query<
    { adapter_id: string; cwd: string; webhook_url: string },
    [string]
  >(
    "SELECT adapter_id, cwd, webhook_url FROM sessions WHERE id = ? AND status = 'recovering'",
  ).get(data.session_id) as { adapter_id: string; cwd: string; webhook_url: string } | null;
  if (!sess) return errorResponse(404, "session_not_recovering", "no recovering session with that id", ctx.requestId);
  assertOwnership(ctx, sess.adapter_id);

  if (resuming.has(data.session_id)) {
    // A resume is already running — idempotent ack; the first attempt's
    // outcome will arrive as a session_resumed / session_dead webhook.
    return jsonResponse(200, { session_id: data.session_id, status: "recovering" });
  }
  resuming.add(data.session_id);

  const mcp = join(sess.cwd, ".mcp.json");
  let succeeded = false;
  let lastError: string | null = null;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, __resumeHooks.backoffMs));
      try {
        await launchSession({
          runtime: ctx.runtime, bus: ctx.bus,
          sessionId: data.session_id,
          cwd: sess.cwd,
          resume: true,
          mcpConfigPath: existsSync(mcp) ? mcp : undefined,
          readyGraceMs: __resumeHooks.launchGraceMs,
        });
        succeeded = true;
        break;
      } catch (err) {
        lastError = `${String(err)} (attempt ${attempt + 1})`;
      }
    }
  } finally {
    resuming.delete(data.session_id);
  }

  const now = Date.now();
  if (succeeded) {
    ctx.db.raw.run("UPDATE sessions SET status = 'live', recovery_expires_at = NULL, updated_at = ? WHERE id = ?", [now, data.session_id]);
    enqueueWebhook(ctx.db, {
      eventType: "session_resumed",
      sessionId: data.session_id,
      adapterId: sess.adapter_id,
      webhookUrl: sess.webhook_url,
      payload: { session_id: data.session_id },
    });
    return jsonResponse(200, { session_id: data.session_id, status: "live" });
  }

  ctx.db.raw.run("UPDATE sessions SET status = 'dead', updated_at = ? WHERE id = ?", [now, data.session_id]);
  enqueueWebhook(ctx.db, {
    eventType: "session_dead",
    sessionId: data.session_id,
    adapterId: sess.adapter_id,
    webhookUrl: sess.webhook_url,
    payload: { session_id: data.session_id, reason: "resume_failed", error: lastError },
  });
  return jsonResponse(200, { session_id: data.session_id, status: "dead", error: lastError });
};
