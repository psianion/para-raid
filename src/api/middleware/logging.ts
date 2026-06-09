import type { Handler } from "../router";

export function withLoggingMiddleware(handler: Handler): Handler {
  return async (req, ctx, params) => {
    const start = Date.now();
    const res = await handler(req, ctx, params);
    const duration = Date.now() - start;
    const url = new URL(req.url);
    ctx.logger.info("api.request", {
      method: req.method,
      path: url.pathname,
      status: res.status,
      duration_ms: duration,
    });
    return res;
  };
}
