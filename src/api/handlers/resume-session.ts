import { z } from "zod";
import { assertOwnership, type Handler } from "../router";
import { jsonResponse, errorResponse } from "../envelope";
import { enqueueWebhook } from "../../publisher/enqueue";

const Req = z.object({
  session_id: z.string().uuid(),
});

/**
 * Spawn `claude --resume <session_id>` and wait for exit.
 * Returns true iff the process exits 0. Override-able by tests via the
 * `__resumeSpawn` test hook (see below).
 */
async function defaultResumeSpawn(sessionId: string, cwd: string): Promise<boolean> {
  const proc = Bun.spawn(["claude", "--resume", sessionId], {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
}

// Test seam: tests overwrite this to skip Bun.spawn entirely.
// Production code never touches it.
export const __resumeHooks: {
  spawn: (sessionId: string, cwd: string) => Promise<boolean>;
  backoffMs: number;
} = {
  spawn: defaultResumeSpawn,
  backoffMs: 5_000,
};

// In-flight resume claims. Two deliveries of the same recover-candidate can
// both pass the status='recovering' SQL guard (the first only flips status
// AFTER its spawn finishes); the loser's failed spawn then overwrites 'live'
// with 'dead'. Single daemon process, so a synchronous Set claim is atomic.
const resuming = new Set<string>();

export const resumeSessionHandler: Handler = async (req, ctx) => {
  const body = await req.json().catch(() => null);
  const parsed = Req.safeParse(body);
  if (!parsed.success) return errorResponse(400, "invalid_request", parsed.error.message, ctx.requestId);
  const data = parsed.data;

  const sess = ctx.db.raw.query<
    { adapter_id: string; tmux_session: string; cwd: string; webhook_url: string },
    [string]
  >(
    "SELECT adapter_id, tmux_session, cwd, webhook_url FROM sessions WHERE id = ? AND status = 'recovering'",
  ).get(data.session_id) as { adapter_id: string; tmux_session: string; cwd: string; webhook_url: string } | null;
  if (!sess) return errorResponse(404, "session_not_recovering", "no recovering session with that id", ctx.requestId);
  assertOwnership(ctx, sess.adapter_id);

  if (resuming.has(data.session_id)) {
    // A resume is already running — idempotent ack; the first attempt's
    // outcome will arrive as a session_resumed / session_dead webhook.
    return jsonResponse(200, { session_id: data.session_id, status: "recovering" });
  }
  resuming.add(data.session_id);

  // Re-adopt before respawn: with KillMode=process the tmux pane (and the
  // claude inside it) survives daemon restarts. That claude never stopped —
  // its hooks still append to the same events file the tailer reads — so
  // recovery is just marking it live. `claude --resume` on a still-running
  // session spawns a doomed second instance and fails every attempt.
  const panePid = await ctx.tmux.listPanePid(sess.tmux_session).catch(() => null);
  if (panePid !== null) {
    resuming.delete(data.session_id);
    ctx.db.raw.run("UPDATE sessions SET status = 'live', updated_at = ? WHERE id = ?", [Date.now(), data.session_id]);
    enqueueWebhook(ctx.db, {
      eventType: "session_resumed",
      sessionId: data.session_id,
      adapterId: sess.adapter_id,
      webhookUrl: sess.webhook_url,
      payload: { session_id: data.session_id, readopted: true },
    });
    return jsonResponse(200, { session_id: data.session_id, status: "live" });
  }

  // 3 attempts with backoff. We do this synchronously inside the request so
  // the caller learns whether resume succeeded; the smoke calls /resume_session
  // and then exits, and there's nothing useful to do in the background.
  let succeeded = false;
  let lastError: string | null = null;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, __resumeHooks.backoffMs));
      try {
        succeeded = await __resumeHooks.spawn(data.session_id, sess.cwd);
        if (succeeded) break;
        lastError = `claude --resume exited non-zero (attempt ${attempt + 1})`;
      } catch (err) {
        lastError = String(err);
      }
    }
  } finally {
    resuming.delete(data.session_id);
  }

  const now = Date.now();
  if (succeeded) {
    ctx.db.raw.run("UPDATE sessions SET status = 'live', updated_at = ? WHERE id = ?", [now, data.session_id]);
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
