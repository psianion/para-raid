import type { Handler } from "../router";
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
 * Bearer auth. When auth.mode is "bearer", every request must carry
 * `Authorization: Bearer <token>` matching config.auth.token. mode "none"
 * passes through — the boot gate only permits "none" on the owner-only unix
 * socket; "mtls" is refused at boot.
 */
export function withAuthMiddleware(handler: Handler): Handler {
  return async (req, ctx, params) => {
    if (ctx.config.auth.mode === "bearer") {
      const header = req.headers.get("authorization") ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!presented || !tokenMatches(presented, ctx.config.auth.token ?? "")) {
        return errorResponse(401, "unauthorized", "missing or invalid bearer token", ctx.requestId);
      }
    }
    return handler(req, ctx, params);
  };
}
