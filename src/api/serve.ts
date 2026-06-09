import type { Handler } from "./router";
import { withRequestIdMiddleware } from "./middleware/request-id";
import { withLoggingMiddleware } from "./middleware/logging";
import { withIdempotencyMiddleware } from "./middleware/idempotency";
import { withAuthMiddleware } from "./middleware/auth";

/**
 * Wraps a handler with the v1 middleware stack:
 * request-id (outermost) → logging → idempotency → auth → handler
 */
export function withMiddleware(handler: Handler): Handler {
  return withRequestIdMiddleware(withLoggingMiddleware(withIdempotencyMiddleware(withAuthMiddleware(handler))));
}
