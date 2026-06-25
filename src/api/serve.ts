import type { Handler } from "./router";
import { withRequestIdMiddleware } from "./middleware/request-id";
import { withLoggingMiddleware } from "./middleware/logging";
import { withIdempotencyMiddleware } from "./middleware/idempotency";
import { withAuthMiddleware } from "./middleware/auth";

/**
 * Wraps a handler with the v1 middleware stack:
 * request-id (outermost) → logging → auth → idempotency → handler
 *
 * auth runs BEFORE idempotency so idempotency can scope its cache key by the
 * authenticated ctx.adapter_id rather than a spoofable request header.
 */
export function withMiddleware(handler: Handler): Handler {
  return withRequestIdMiddleware(withLoggingMiddleware(withAuthMiddleware(withIdempotencyMiddleware(handler))));
}
