import type { Handler } from "../router";
import { ADMIN_ID } from "../router";
import { errorResponse } from "../envelope";
import { createHash, timingSafeEqual } from "crypto";

/** Constant-time token compare. Hashing first gives fixed-length buffers,
 *  so timingSafeEqual never throws on length mismatch and length isn't leaked. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Bearer auth + per-adapter identity. When auth.mode is "bearer", every request
 * must carry `Authorization: Bearer <token>`. The token alone decides identity:
 *   - matches config.auth.token        → ctx.adapter_id = ADMIN_ID (global/admin)
 *   - matches an adapters[id].token     → ctx.adapter_id = that id
 *   - otherwise                         → 401
 * Identity is NEVER read from a request header (X-Adapter-Id is spoofable and is
 * no longer trusted). mode "none" passes through — the boot gate only permits
 * "none" on the owner-only unix socket — and is treated as admin so the local
 * owner retains full access; "mtls" is refused at boot.
 *
 * ponytail: we don't reject a present-but-mismatched X-Adapter-Id header —
 * YAGNI for a header we no longer read at all. Upgrade path: if a client still
 * sends it and we want to fail loud, compare it to the derived id here.
 */
export function withAuthMiddleware(handler: Handler): Handler {
  return async (req, ctx, params) => {
    if (ctx.config.auth.mode === "bearer") {
      const header = req.headers.get("authorization") ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!presented) {
        return errorResponse(401, "unauthorized", "missing or invalid bearer token", ctx.requestId);
      }
      if (ctx.config.auth.token && tokenMatches(presented, ctx.config.auth.token)) {
        ctx.adapter_id = ADMIN_ID;
      } else {
        let matched: string | null = null;
        for (const [id, cfg] of Object.entries(ctx.config.adapters ?? {})) {
          if (cfg.token && tokenMatches(presented, cfg.token)) { matched = id; break; }
        }
        if (matched === null) {
          return errorResponse(401, "unauthorized", "missing or invalid bearer token", ctx.requestId);
        }
        ctx.adapter_id = matched;
      }
    } else {
      // mode "none": owner-only socket, full access.
      ctx.adapter_id = ADMIN_ID;
    }
    return handler(req, ctx, params);
  };
}
