import { z } from "zod";
import { randomUUID, createHash } from "crypto";
import { provisionWorkdir } from "../../workdir";
import { renderMcpJson } from "../../bundles/renderer";
import { launchSession } from "../../sessions/launcher";
import { ADMIN_ID, type Handler } from "../router";
import { jsonResponse, errorResponse } from "../envelope";
import { enqueueWebhook } from "../../publisher/enqueue";

// Identity is the authenticated caller (ctx.adapter_id) and the webhook_url is
// the adapter's configured value — neither is taken from the body, so the body
// carries only the session inputs.
const Req = z.object({
  adapter_ref: z.string().min(1),
  prompt: z.string().min(1),
  bundle_name: z.string().optional(),
});

export const openSessionHandler: Handler = async (req, ctx) => {
  const body = await req.json().catch(() => null);
  const parsed = Req.safeParse(body);
  if (!parsed.success) return errorResponse(400, "invalid_request", parsed.error.message, ctx.requestId);
  const data = parsed.data;

  // Identity is the authenticated caller; admin does not own sessions.
  const adapterId = ctx.adapter_id ?? "";
  if (adapterId === ADMIN_ID) return errorResponse(403, "forbidden", "admin token cannot open a session — use a per-adapter token", ctx.requestId);
  const adapterCfg = ctx.config.adapters?.[adapterId];
  if (!adapterCfg) return errorResponse(403, "forbidden", "no adapter config for the authenticated caller", ctx.requestId);
  const webhookUrl = adapterCfg.webhook_url;

  if (ctx.modeController.isPaused()) return errorResponse(503, "paused", "daemon is paused", ctx.requestId);

  // Reclaim check
  const recov = ctx.db.raw.query<{ id: string; cwd: string }, [string, string]>(
    "SELECT id, cwd FROM sessions WHERE adapter_id = ? AND adapter_ref = ? AND status = 'recovering' LIMIT 1"
  ).get(adapterId, data.adapter_ref) as { id: string; cwd: string } | null;
  if (recov) {
    enqueueWebhook(ctx.db, { eventType: "session_recover_candidate", sessionId: recov.id, adapterId, webhookUrl, payload: { reason: "open_session_reclaim" } });
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
  const workdir = provisionWorkdir(ctx.config.daemon.data_dir, sessionId);
  let mcpConfigPath: string | undefined;
  if (data.bundle_name) {
    // Render .mcp.json so the worker can reach the bundle's MCP servers
    // (e.g. scrypt); it is passed to claude via --mcp-config. Fail fast if
    // the bundle name is unknown.
    try { mcpConfigPath = renderMcpJson(ctx.bundles ?? [], data.bundle_name, workdir); }
    catch (e) { return errorResponse(400, "unknown_bundle", String(e), ctx.requestId); }
  }
  const promptSha256 = createHash("sha256").update(data.prompt).digest("hex");

  ctx.db.transaction(() => {
    const now = Date.now();
    ctx.db.raw.run(
      `INSERT INTO sessions (id, adapter_id, adapter_ref, status, cwd, mcp_bundle, webhook_url, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [sessionId, adapterId, data.adapter_ref, "launching", workdir, data.bundle_name ?? "", webhookUrl, now, now]
    );
    ctx.db.raw.run(
      `INSERT INTO turns (id, session_id, status, prompt_sha256, created_at)
       VALUES (?,?,?,?,?)`,
      [turnId, sessionId, "pending", promptSha256, now]
    );
    enqueueWebhook(ctx.db, { eventType: "session_open_acknowledged", sessionId, adapterId, webhookUrl, payload: { session_id: sessionId, turn_id: turnId } });
  });

  // Async: launch + dispatch first turn (fire-and-forget)
  (async () => {
    try {
      await launchSession({
        runtime: ctx.runtime, bus: ctx.bus,
        // No timeoutMs override: the launcher default (120s) governs — 30s
        // killed healthy cold-boot launches on slower machines.
        sessionId, cwd: workdir, mcpConfigPath,
      });
      ctx.db.raw.run("UPDATE sessions SET status = 'live', updated_at = ? WHERE id = ?", [Date.now(), sessionId]);
      enqueueWebhook(ctx.db, { eventType: "session_live", sessionId, adapterId, webhookUrl, payload: { session_id: sessionId } });

      ctx.db.raw.run("UPDATE turns SET status = 'dispatching', dispatched_at = ? WHERE id = ?", [Date.now(), turnId]);
      const reply = await ctx.dispatcher.enqueue({ session_id: sessionId, turn_id: turnId, prompt: data.prompt });
      ctx.db.raw.run("UPDATE turns SET status = 'completed', completed_at = ? WHERE id = ?", [Date.now(), turnId]);
      enqueueWebhook(ctx.db, { eventType: "turn_replied", sessionId, adapterId, webhookUrl, payload: { session_id: sessionId, turn_id: turnId, reply } });
    } catch (err) {
      ctx.logger.error("open_session.async_failed", { session_id: sessionId, error: String(err) });
      ctx.db.raw.run("UPDATE sessions SET status = 'dead', updated_at = ? WHERE id = ?", [Date.now(), sessionId]);
      ctx.db.raw.run("UPDATE turns SET status = 'failed', completed_at = ?, error = ? WHERE id = ? AND status NOT IN ('completed','cancelled','failed')", [Date.now(), String(err), turnId]);
      ctx.runtime.get(sessionId)?.kill("SIGTERM");
      enqueueWebhook(ctx.db, { eventType: "session_dead", sessionId, adapterId, webhookUrl, payload: { reason: "launch_failed", error: String(err) } });
    }
  })();

  return jsonResponse(202, { session_id: sessionId, turn_id: turnId, status: "launching" });
};
