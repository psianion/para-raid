import { randomUUID } from "crypto";
import type { Handler, HandlerCtx } from "../router";
import { withRequestId } from "../../logger";

export function withRequestIdMiddleware(handler: Handler): Handler {
  return async (req, ctx, params) => {
    const id = req.headers.get("X-Request-ID") ?? randomUUID();
    return withRequestId(id, async () => {
      const newCtx: HandlerCtx = { ...ctx, requestId: id };
      const res = await handler(req, newCtx, params);
      const headers = new Headers(res.headers);
      headers.set("X-Request-ID", id);
      return new Response(res.body, { status: res.status, headers });
    });
  };
}
