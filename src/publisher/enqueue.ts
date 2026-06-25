import { randomUUID } from "crypto";
import type { Db } from "../db";
import type { WebhookEventType } from "../types";

/**
 * The single place that writes a row to `webhook_queue`. Every handler and
 * recovery path enqueues through here, so the column list and the
 * `{event_type, session_id, ...payload}` body shape live in one spot — when the
 * event taxonomy is realigned (Phase 3), it changes here, not in 11 copies.
 */
export function enqueueWebhook(
  db: Db,
  args: {
    eventType: WebhookEventType;
    sessionId: string | null;
    adapterId: string;
    webhookUrl: string;
    payload?: Record<string, unknown>;
  },
): void {
  const now = Date.now();
  db.raw.run(
    `INSERT INTO webhook_queue (event_id, session_id, adapter_id, event_type, payload_json, webhook_url, status, attempt_count, next_attempt_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      randomUUID(),
      args.sessionId,
      args.adapterId,
      args.eventType,
      JSON.stringify({ event_type: args.eventType, session_id: args.sessionId, ...args.payload }),
      args.webhookUrl,
      "pending",
      0,
      now,
      now,
    ],
  );
}

/** Fan a pause/resume mode change out to every configured adapter that has a
 *  webhook_url (session_id is null — it's a daemon-wide event). */
export function enqueueModeWebhooks(
  db: Db,
  adapters: Record<string, { webhook_url: string }>,
  eventType: "paused" | "resumed",
): void {
  const at = Date.now();
  const mode = eventType === "paused" ? "paused" : "running";
  for (const [adapterId, cfg] of Object.entries(adapters)) {
    if (!cfg.webhook_url) continue;
    enqueueWebhook(db, { eventType, sessionId: null, adapterId, webhookUrl: cfg.webhook_url, payload: { mode, at } });
  }
}
