import { z } from "zod";
import { randomUUID, createHash } from "crypto";
import { provisionWorkdir, acceptClaudeTrust, writeClaudeSettings } from "../../workdir";
import { renderMcpJson } from "../../bundles/renderer";
import { launchSession } from "../../sessions/launcher";
import type { Handler, HandlerCtx } from "../router";
import { jsonResponse, errorResponse } from "../envelope";
import { isSafeWebhookUrl } from "../../publisher/webhook-url";
import type { WebhookEventType } from "../../types";

const Req = z.object({
  adapter_id: z.string().min(1),
  adapter_ref: z.string().min(1),
  prompt: z.string().min(1),
  webhook_url: z.string().url().refine(isSafeWebhookUrl, "webhook_url host is not allowed"),
  bundle_name: z.string().optional(),
});

function shortHash(s: string): string {
  // Deterministic short hash for tmux name. djb2 → base36, 8 chars.
  let h = 5381;
  for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  return Math.abs(h).toString(36).slice(0, 8);
}

function enqueueWebhook(ctx: HandlerCtx, eventType: WebhookEventType, sessionId: string, payload: Record<string, unknown>, webhookUrl: string, adapterId: string) {
  ctx.db.raw.run(
    `INSERT INTO webhook_queue (event_id, session_id, adapter_id, event_type, payload_json, webhook_url, status, attempt_count, next_attempt_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [randomUUID(), sessionId, adapterId, eventType, JSON.stringify({ event_type: eventType, session_id: sessionId, ...payload }), webhookUrl, "pending", 0, Date.now(), Date.now()]
  );
}

export const openSessionHandler: Handler = async (req, ctx) => {
  const body = await req.json().catch(() => null);
  const parsed = Req.safeParse(body);
  if (!parsed.success) return errorResponse(400, "invalid_request", parsed.error.message, ctx.requestId);
  const data = parsed.data;

  if (ctx.modeController.isPaused()) return errorResponse(503, "paused", "daemon is paused", ctx.requestId);

  // Reclaim check
  const recov = ctx.db.raw.query<{ id: string; cwd: string }, [string, string]>(
    "SELECT id, cwd FROM sessions WHERE adapter_id = ? AND adapter_ref = ? AND status = 'recovering' LIMIT 1"
  ).get(data.adapter_id, data.adapter_ref) as { id: string; cwd: string } | null;
  if (recov) {
    enqueueWebhook(ctx, "session_recover_candidate", recov.id, { reason: "open_session_reclaim" }, data.webhook_url, data.adapter_id);
    return jsonResponse(200, { session_id: recov.id, status: "recovering" });
  }

  // Cap check
  const liveCount = ctx.db.raw.query<{ n: number }, []>(
    "SELECT COUNT(*) as n FROM sessions WHERE status IN ('live','launching','recovering')"
  ).get()!.n;
  if (liveCount >= ctx.config.concurrency.max_total_sessions) {
    return errorResponse(429, "pool_full", `max_total_sessions=${ctx.config.concurrency.max_total_sessions} reached`, ctx.requestId);
  }

  // Synchronous provisioning
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const tmuxName = `para-raid-${shortHash(data.adapter_ref)}`;
  const workdir = provisionWorkdir((ctx.config.daemon as any).data_dir, sessionId);
  acceptClaudeTrust(workdir);
  writeClaudeSettings(workdir, ctx.hookEventsPath, sessionId);
  if (data.bundle_name) {
    // Write .mcp.json so the worker's claude session can reach the bundle's
    // MCP servers (e.g. scrypt). Fail fast if the bundle name is unknown.
    try { renderMcpJson(ctx.bundles ?? [], data.bundle_name, workdir); }
    catch (e) { return errorResponse(400, "unknown_bundle", String(e), ctx.requestId); }
  }
  const promptSha256 = createHash("sha256").update(data.prompt).digest("hex");

  ctx.db.transaction(() => {
    const now = Date.now();
    ctx.db.raw.run(
      `INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [sessionId, data.adapter_id, data.adapter_ref, "launching", tmuxName, workdir, data.bundle_name ?? "", data.webhook_url, now, now]
    );
    ctx.db.raw.run(
      `INSERT INTO turns (id, session_id, status, prompt_sha256, created_at)
       VALUES (?,?,?,?,?)`,
      [turnId, sessionId, "pending", promptSha256, now]
    );
    enqueueWebhook(ctx, "session_open_acknowledged", sessionId, { session_id: sessionId, turn_id: turnId }, data.webhook_url, data.adapter_id);
  });

  // Async: launch + dispatch first turn (fire-and-forget)
  (async () => {
    try {
      await launchSession({
        tmux: ctx.tmux, bus: ctx.bus,
        sessionId, tmuxName, cwd: workdir, timeoutMs: 30_000,
      });
      ctx.db.raw.run("UPDATE sessions SET status = 'live', updated_at = ? WHERE id = ?", [Date.now(), sessionId]);
      enqueueWebhook(ctx, "session_live", sessionId, { session_id: sessionId }, data.webhook_url, data.adapter_id);

      const reply = await ctx.dispatcher.enqueue({ session_id: sessionId, turn_id: turnId, prompt: data.prompt, tmux_session: tmuxName });
      ctx.db.raw.run("UPDATE turns SET status = 'completed', completed_at = ? WHERE id = ?", [Date.now(), turnId]);
      enqueueWebhook(ctx, "turn_replied", sessionId, { session_id: sessionId, turn_id: turnId, reply }, data.webhook_url, data.adapter_id);
    } catch (err) {
      ctx.logger.error("open_session.async_failed", { session_id: sessionId, error: String(err) });
      ctx.db.raw.run("UPDATE sessions SET status = 'dead', updated_at = ? WHERE id = ?", [Date.now(), sessionId]);
      enqueueWebhook(ctx, "session_dead", sessionId, { reason: "launch_failed", error: String(err) }, data.webhook_url, data.adapter_id);
    }
  })();

  return jsonResponse(202, { session_id: sessionId, turn_id: turnId, status: "launching" });
};
