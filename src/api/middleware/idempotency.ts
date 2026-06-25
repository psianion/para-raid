import type { Handler, HandlerCtx } from "../router";

const IDEMPOTENT_METHODS = new Set(["POST", "PUT", "DELETE"]);

export function withIdempotencyMiddleware(handler: Handler): Handler {
  return async (req, ctx, params) => {
    if (!IDEMPOTENT_METHODS.has(req.method)) return handler(req, ctx, params);
    const key = req.headers.get("Idempotency-Key");
    if (!key) return handler(req, ctx, params);

    // Scope by the authenticated identity (auth middleware runs first), not a
    // spoofable header. Falls back to "unknown" only when auth is off (mode
    // "none" actually sets ADMIN_ID, so this is belt-and-suspenders).
    const adapterId = ctx.adapter_id ?? "unknown";
    const endpoint = new URL(req.url).pathname;

    const existing = ctx.db.raw.query<{ response_status: number; response_json: string }, [string, string, string, number]>(
      "SELECT response_status, response_json FROM idempotency_keys WHERE key = ? AND adapter_id = ? AND endpoint = ? AND expires_at > ?"
    ).get(key, adapterId, endpoint, Date.now()) as { response_status: number; response_json: string } | null;

    if (existing) {
      ctx.logger.info("idempotency.replay", { key, endpoint });
      return new Response(existing.response_json, { status: existing.response_status, headers: { "Content-Type": "application/json", "X-Idempotency-Replay": "true" } });
    }

    const res = await handler(req, ctx, params);
    if (res.status >= 200 && res.status < 300) {
      const cloned = res.clone();
      const body = await cloned.text();
      const now = Date.now();
      const ttlMs = 24 * 3600 * 1000;
      try {
        ctx.db.raw.run(
          `INSERT INTO idempotency_keys (key, adapter_id, endpoint, response_status, response_json, first_seen_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [key, adapterId, endpoint, res.status, body, now, now + ttlMs]
        );
      } catch (err) {
        // Race: another concurrent request inserted with same key. Drop silently — caller still gets their response.
        ctx.logger.warn("idempotency.insert_race", { key, error: String(err) });
      }
    }
    return res;
  };
}
