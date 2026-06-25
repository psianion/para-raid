import { createHmac } from "crypto";
import type { Db } from "../db";
import type { Logger } from "../logger";
import { isSafeWebhookUrl } from "./webhook-url";

export function computeNextAttempt(attemptCount: number, backoffMs: number[]): number {
  const idx = Math.min(attemptCount, backoffMs.length - 1);
  return backoffMs[idx];
}

export function shouldDeadLetter(firstAttemptedAt: number, retryWindowMs: number): boolean {
  return Date.now() - firstAttemptedAt > retryWindowMs;
}

export function startPublisher(db: Db, config: { retry_window_ms: number; backoff_ms: number[] }, logger: Logger, signing?: { mode: "none" | "hmac"; secret?: string }) {
  let running = true;

  async function tick() {
    const now = Date.now();
    const events = db.raw.query<{
      id: number; event_id: string; webhook_url: string;
      payload_json: string; attempt_count: number;
      first_attempted_at: number | null; status: string;
    }, [number]>(
      `SELECT id, event_id, webhook_url, payload_json, attempt_count, first_attempted_at, status
       FROM webhook_queue WHERE status IN ('pending','in_flight') AND next_attempt_at <= ? LIMIT 10`
    ).all(now);

    for (const evt of events) {
      if (evt.first_attempted_at && shouldDeadLetter(evt.first_attempted_at, config.retry_window_ms)) {
        db.raw.run("UPDATE webhook_queue SET status = 'dead_letter' WHERE id = ?", [evt.id]);
        logger.warn("publisher.dead_letter", { event_id: evt.event_id });
        continue;
      }

      db.raw.run("UPDATE webhook_queue SET status = 'in_flight' WHERE id = ?", [evt.id]);

      try {
        if (!isSafeWebhookUrl(evt.webhook_url)) throw new Error(`blocked unsafe webhook_url: ${evt.webhook_url}`);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          // Stable per-event id and the adapter's dedup key. The daemon may
          // redeliver the same event after a transient non-2xx, and the signed
          // timestamp changes per attempt, so event_id is the only reliable
          // idempotency key a receiver can use.
          "X-Para-Raid-Event-Id": evt.event_id,
        };
        if (signing?.mode === "hmac" && signing.secret) {
          // Sign `timestamp.body` (Stripe-style) so a receiver can reject stale
          // replays within a skew window, not just verify authenticity.
          const ts = String(Date.now());
          headers["X-Para-Raid-Timestamp"] = ts;
          headers["X-Para-Raid-Signature"] = "sha256=" + createHmac("sha256", signing.secret).update(`${ts}.${evt.payload_json}`).digest("hex");
        }
        const res = await fetch(evt.webhook_url, { method: "POST", headers, body: evt.payload_json });
        if (res.ok) {
          db.raw.run("UPDATE webhook_queue SET status = 'delivered' WHERE id = ?", [evt.id]);
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        const nextDelay = computeNextAttempt(evt.attempt_count, config.backoff_ms);
        db.raw.run(
          `UPDATE webhook_queue SET status = 'pending', attempt_count = attempt_count + 1,
           next_attempt_at = ?, first_attempted_at = COALESCE(first_attempted_at, ?),
           last_error = ? WHERE id = ?`,
          [now + nextDelay, now, String(err), evt.id]
        );
      }
    }
  }

  const interval = setInterval(() => { if (running) tick().catch(() => {}); }, 1000);

  return {
    stop() { running = false; clearInterval(interval); },
    tick,
  };
}
