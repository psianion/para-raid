// src/types.ts

// --- Session ---
export type SessionStatus = "launching" | "live" | "recovering" | "closed" | "dead";

export interface Session {
  id: string;
  adapter_id: string;
  adapter_ref: string;
  tmux_session: string;
  cwd: string;
  mcp_bundle: string;
  webhook_url: string;
  status: SessionStatus;
  created_at: number;
  updated_at: number;
  last_turn_at: number | null;
  recovery_expires_at: number | null;
}

// --- Turn ---
export type TurnStatus = "queued" | "dispatching" | "awaiting_stop" | "completed" | "cancelled" | "failed";

export interface Turn {
  id: string;
  session_id: string;
  status: TurnStatus;
  prompt_sha256: string;
  created_at: number;
  dispatched_at: number | null;
  completed_at: number | null;
  error: string | null;
}

// --- Webhook ---
export type WebhookStatus = "pending" | "in_flight" | "delivered" | "dead_letter";

// The single source of truth for the webhook contract: exactly the event types
// the daemon emits (one per kind of `INSERT INTO webhook_queue`). The emit
// helpers type their eventType param as WebhookEventType, so tsc rejects drift.
export const WEBHOOK_EVENT_TYPES = [
  "session_open_acknowledged",
  "session_live",
  "turn_replied",
  "turn_failed",
  "turn_cancelled",
  "session_dead",
  "session_recover_candidate",
  "session_recycled",
  "session_closed",
  "session_resumed",
  "tool_call",
  "paused",
  "resumed",
] as const;
export type WebhookEventType = typeof WEBHOOK_EVENT_TYPES[number];

export interface WebhookEvent {
  id: number;
  event_id: string;
  session_id: string | null;
  adapter_id: string;
  event_type: WebhookEventType;
  payload_json: string;
  webhook_url: string;
  status: WebhookStatus;
  attempt_count: number;
  next_attempt_at: number;
  first_attempted_at: number | null;
  last_error: string | null;
  created_at: number;
}

// --- Idempotency ---
export interface IdempotencyKey {
  key: string;
  adapter_id: string;
  endpoint: string;
  response_status: number;
  response_json: string;
  first_seen_at: number;
  expires_at: number;
}

// --- Tailer ---
export interface TailerState {
  id: string;
  file_path: string;
  file_inode: number;
  offset: number;
  updated_at: number;
}

// --- Transcript ---
export interface TranscriptOffset {
  session_id: string;
  transcript_path: string;
  last_scanned_offset: number;
  updated_at: number;
}

// --- Hook Events ---
export interface HookEvent {
  hook_event_name: "SessionStart" | "Stop" | "PreToolUse" | "SessionEnd";
  session_id: string;
  cwd: string;
  transcript_path?: string;
  last_assistant_message?: string;
  permission_mode?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

// --- Mode ---
export type DaemonMode = "running" | "paused";

// --- Config ---
export interface ParaRaidConfig {
  daemon: { socket_path: string; data_dir: string };
  claude: { allowed_versions: string[]; env_setup: string };
  concurrency: { max_concurrent_turns: number; max_total_sessions: number; turn_timeout_ms: number };
  recovery: { grace_window_ms: number };
  publisher: { retry_window_ms: number; backoff_ms: number[] };
  limit: { warning_regex: string };
  observability: { ram_warn_pct: number; ram_refuse_pct: number; stats_interval_ms: number };
  auth: { mode: "none" | "bearer" | "mtls"; token?: string };
  signing: { mode: "none" | "hmac"; secret?: string };
  adapters: Record<string, { webhook_url: string; token: string }>;
}

// --- API ---
export interface ApiError {
  error: { code: string; message: string; request_id: string };
}

export interface OpenSessionReq {
  adapter_id: string;
  adapter_ref: string;
  mcp_bundle: string;
  webhook_url?: string;
  first_prompt: string;
}

export interface SendTurnReq {
  session_id: string;
  prompt: string;
}

export interface CancelTurnReq {
  session_id: string;
  turn_id: string;
}

export interface RecycleSessionReq {
  session_id: string;
}

export interface CloseSessionReq {
  session_id: string;
}

export interface ResumeSessionReq {
  session_id: string;
}

// --- Dispatcher Job ---
export interface DispatchJob {
  session_id: string;
  turn_id: string;
  prompt: string;
  tmux_session: string;
}
