import { createHmac, timingSafeEqual } from "node:crypto";

export interface ReceivedEvent {
  event_id: string;
  event_type: string;
  session_id: string | null;
  body: Record<string, unknown>;
}

export interface ReferenceReceiver {
  /** Set this as an adapter's `webhook_url` in para-raid config. */
  url: string;
  /** Events received in delivery order (after signature check + dedup). */
  events: ReceivedEvent[];
  stop(): void;
}

/**
 * The canonical para-raid webhook receiver. An adapter exposes ONE HTTP
 * endpoint and para-raid POSTs every event to it. This reference implementation
 * does the two things every real adapter must:
 *
 *   1. Verify authenticity. When the daemon runs `signing.mode = "hmac"`, each
 *      delivery carries `X-Para-Raid-Timestamp` and `X-Para-Raid-Signature`
 *      (`sha256=<hex>`). The signature is HMAC-SHA256 over `${timestamp}.${rawBody}`
 *      using the shared `signing.secret`. Reject anything that doesn't verify.
 *   2. Dedupe. The daemon redelivers an event after a transient non-2xx, and the
 *      timestamp changes per attempt — so `X-Para-Raid-Event-Id` is the only
 *      stable idempotency key. Record each id at most once.
 *
 * The body is raw JSON: `{ event_type, session_id, ...event-specific payload }`.
 * Return 2xx to mark the event delivered; any other status makes the daemon retry.
 */
export function createReferenceReceiver(opts: { secret?: string; port?: number } = {}): ReferenceReceiver {
  const events: ReceivedEvent[] = [];
  const seen = new Set<string>();

  const server = Bun.serve({
    port: opts.port ?? 0, // 0 → OS-assigned free port
    hostname: "127.0.0.1",
    async fetch(req) {
      const raw = await req.text();

      // 1. Authenticity — verify before trusting any field.
      if (opts.secret) {
        const ts = req.headers.get("X-Para-Raid-Timestamp") ?? "";
        const sig = req.headers.get("X-Para-Raid-Signature") ?? "";
        if (!verifySignature(opts.secret, ts, raw, sig)) {
          return new Response("invalid signature", { status: 401 });
        }
      }

      // 2. Dedup on the event id — redeliveries are acknowledged but ignored.
      const eventId = req.headers.get("X-Para-Raid-Event-Id") ?? "";
      if (eventId && seen.has(eventId)) return new Response("ok (duplicate)");

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
      } catch {
        return new Response("invalid json", { status: 400 });
      }

      if (eventId) seen.add(eventId);
      events.push({
        event_id: eventId,
        event_type: String(body.event_type ?? ""),
        session_id: (body.session_id as string | null) ?? null,
        body,
      });
      return new Response("ok");
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/hook`,
    events,
    stop: () => server.stop(true),
  };
}

/** Constant-time check of `sha256=<hex>` over `${ts}.${rawBody}`. */
function verifySignature(secret: string, ts: string, rawBody: string, signature: string): boolean {
  if (!ts || !signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
