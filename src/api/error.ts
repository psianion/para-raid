export type ApiErrorCode =
  | "invalid_request"
  | "not_found"
  | "pool_full"
  | "paused"
  | "idempotency_replay"
  | "internal"
  | "tmux_unhealthy"
  | "session_not_live"
  | "session_not_recovering"
  | "version_not_allowed"
  | "unknown_bundle"
  | "unauthorized";

export class ApiError extends Error {
  constructor(public status: number, public code: ApiErrorCode, message: string) {
    super(message);
  }
}
