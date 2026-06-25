import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { createHarness, waitFor, TEST_ADAPTER_TOKEN, type Harness } from "./harness";
import { createReferenceReceiver, type ReferenceReceiver } from "../../examples/reference-adapter/receiver";
import { createReferenceClient } from "../../examples/reference-adapter/client";

// >= 16 chars so it would pass the daemon's signing boot gate too.
const SECRET = "ref-adapter-secret-0123456789abcdef";

describe("reference adapter end-to-end", () => {
  let h: Harness;
  let receiver: ReferenceReceiver;

  beforeEach(async () => {
    receiver = createReferenceReceiver({ secret: SECRET });
    // Sign deliveries and point the adapter's webhook_url at the reference receiver.
    h = await createHarness({ signing: { mode: "hmac", secret: SECRET }, webhookUrl: receiver.url });
  });
  afterEach(async () => {
    await h.shutdown();
    receiver.stop();
  });

  test("drives a session over the socket and receives the signed webhook sequence", async () => {
    const client = createReferenceClient({ socketPath: h.socket, token: TEST_ADAPTER_TOKEN });

    const open = await client.openSession({ adapter_ref: "ref-e2e", prompt: "say hi" });
    expect(open.status).toBe(202);
    const sid: string = open.body.session_id;
    expect(sid).toMatch(/[0-9a-f-]{36}/);

    // First webhook is enqueued synchronously and delivered by the REAL publisher
    // loop over HTTP to our receiver (signature-verified before it's recorded).
    await waitFor(() => receiver.events.some((e) => e.event_type === "session_open_acknowledged" && e.session_id === sid), 3_000);

    // Drive launch + first turn exactly as the worker's hooks would.
    await waitFor(() => h.fakeTmux.calls.some((c) => c.method === "newSession"));
    h.emitHookEvent({ hook_event_name: "SessionStart" as any, session_id: sid });
    await waitFor(() => h.fakeTmux.calls.some((c) => c.method === "sendKeysLiteral" && (c.args as any[])[0]?.toString().startsWith("para-raid-")));
    h.emitHookEvent({ hook_event_name: "Stop" as any, session_id: sid, last_assistant_message: "hi" });

    const live = await waitFor(() => receiver.events.find((e) => e.event_type === "session_live" && e.session_id === sid), 3_000);
    const replied = await waitFor(() => receiver.events.find((e) => e.event_type === "turn_replied" && e.session_id === sid), 3_000);

    // Contract: turn_replied carries the turn id + a string reply.
    expect(typeof replied.body.turn_id).toBe("string");
    expect(typeof replied.body.reply).toBe("string");

    // Every recorded event passed HMAC verification and carries a unique id
    // (the daemon now sends X-Para-Raid-Event-Id for dedup).
    expect(live.event_id).toMatch(/[0-9a-f-]{36}/);
    const ids = receiver.events.map((e) => e.event_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("rejects a webhook with a bad signature (401, not recorded)", async () => {
    const before = receiver.events.length;
    const res = await fetch(receiver.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Para-Raid-Timestamp": String(Date.now()),
        "X-Para-Raid-Signature": "sha256=deadbeef",
        "X-Para-Raid-Event-Id": "evt-forged",
      },
      body: JSON.stringify({ event_type: "turn_replied", session_id: "s1" }),
    });
    expect(res.status).toBe(401);
    expect(receiver.events.length).toBe(before);
  });

  test("dedupes a redelivered event_id (records once, acks both)", async () => {
    const before = receiver.events.length;
    const body = JSON.stringify({ event_type: "session_live", session_id: "s-dup" });
    const ts = String(Date.now());
    const headers = {
      "Content-Type": "application/json",
      "X-Para-Raid-Timestamp": ts,
      "X-Para-Raid-Signature": "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex"),
      "X-Para-Raid-Event-Id": "evt-dup-1",
    };
    const r1 = await fetch(receiver.url, { method: "POST", headers, body });
    const r2 = await fetch(receiver.url, { method: "POST", headers, body });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(receiver.events.length).toBe(before + 1);
  });
});
