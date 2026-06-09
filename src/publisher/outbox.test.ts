import { test, expect, beforeEach, afterEach } from "bun:test";
import { createHmac } from "crypto";
import { computeNextAttempt, shouldDeadLetter, startPublisher } from "./outbox";
import { createDb } from "../db";
import type { Db } from "../db";

const NOOP_LOGGER = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
} as any;

test("computeNextAttempt follows backoff schedule", () => {
  const backoff = [1000, 2000, 4000];
  expect(computeNextAttempt(0, backoff)).toBe(1000);
  expect(computeNextAttempt(1, backoff)).toBe(2000);
  expect(computeNextAttempt(2, backoff)).toBe(4000);
  expect(computeNextAttempt(5, backoff)).toBe(4000);
});

test("shouldDeadLetter returns true when retry window expired", () => {
  expect(shouldDeadLetter(Date.now() - 700_000, 600_000)).toBe(true);
});

test("shouldDeadLetter returns false within retry window", () => {
  expect(shouldDeadLetter(Date.now() - 300_000, 600_000)).toBe(false);
});

test("publisher delivers to mocked fetch and marks delivered", async () => {
  const db: Db = createDb(":memory:");
  const calls: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => { calls.push(url); return new Response("ok", { status: 200 }); }) as any;

  db.raw.run(
    `INSERT INTO webhook_queue (event_id, adapter_id, event_type, payload_json, webhook_url, status, attempt_count, next_attempt_at, created_at)
     VALUES ('e1','adp','reply','{}','http://x/hook','pending',0,?,?)`,
    [Date.now() - 1, Date.now()]
  );

  const pub = startPublisher(db, { retry_window_ms: 600_000, backoff_ms: [1000] }, NOOP_LOGGER);
  await pub.tick();
  pub.stop();
  globalThis.fetch = origFetch;

  const row = db.raw.query<{ status: string }, []>("SELECT status FROM webhook_queue WHERE event_id='e1'").get();
  expect(row!.status).toBe("delivered");
  expect(calls).toEqual(["http://x/hook"]);
  db.close();
});

test("publisher HMAC-signs the timestamped body when signing.mode is hmac", async () => {
  const db: Db = createDb(":memory:");
  let seenSig: string | undefined;
  let seenTs: string | undefined;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    seenSig = init.headers["X-Para-Raid-Signature"];
    seenTs = init.headers["X-Para-Raid-Timestamp"];
    return new Response("ok", { status: 200 });
  }) as any;

  db.raw.run(
    `INSERT INTO webhook_queue (event_id, adapter_id, event_type, payload_json, webhook_url, status, attempt_count, next_attempt_at, created_at)
     VALUES ('e9','adp','reply','{"a":1}','http://x/hook','pending',0,?,?)`,
    [Date.now() - 1, Date.now()]
  );
  const secret = "0123456789abcdef0123456789abcdef";
  const pub = startPublisher(db, { retry_window_ms: 600_000, backoff_ms: [1000] }, NOOP_LOGGER, { mode: "hmac", secret });
  await pub.tick();
  pub.stop();
  globalThis.fetch = origFetch;

  expect(seenTs).toMatch(/^\d+$/);
  expect(seenSig).toBe("sha256=" + createHmac("sha256", secret).update(`${seenTs}.{"a":1}`).digest("hex"));
  db.close();
});

test("publisher does not sign when signing.mode is none", async () => {
  const db: Db = createDb(":memory:");
  let seenSig: string | undefined = "untouched";
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => { seenSig = init.headers["X-Para-Raid-Signature"]; return new Response("ok", { status: 200 }); }) as any;

  db.raw.run(
    `INSERT INTO webhook_queue (event_id, adapter_id, event_type, payload_json, webhook_url, status, attempt_count, next_attempt_at, created_at)
     VALUES ('e10','adp','reply','{}','http://x/hook','pending',0,?,?)`,
    [Date.now() - 1, Date.now()]
  );
  const pub = startPublisher(db, { retry_window_ms: 600_000, backoff_ms: [1000] }, NOOP_LOGGER, { mode: "none", secret: "" });
  await pub.tick();
  pub.stop();
  globalThis.fetch = origFetch;

  expect(seenSig).toBeUndefined();
  db.close();
});

test("publisher refuses to deliver to a blocked webhook_url", async () => {
  const db: Db = createDb(":memory:");
  const calls: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => { calls.push(url); return new Response("ok", { status: 200 }); }) as any;

  db.raw.run(
    `INSERT INTO webhook_queue (event_id, adapter_id, event_type, payload_json, webhook_url, status, attempt_count, next_attempt_at, created_at)
     VALUES ('e3','adp','reply','{}','http://169.254.169.254/latest/meta-data/','pending',0,?,?)`,
    [Date.now() - 1, Date.now()]
  );

  const pub = startPublisher(db, { retry_window_ms: 600_000, backoff_ms: [1000] }, NOOP_LOGGER);
  await pub.tick();
  pub.stop();
  globalThis.fetch = origFetch;

  expect(calls).toEqual([]); // never reaches the metadata endpoint
  const row = db.raw.query<{ status: string }, []>("SELECT status FROM webhook_queue WHERE event_id='e3'").get();
  expect(row!.status).not.toBe("delivered");
  db.close();
});

test("publisher retries on non-2xx then dead-letters past window", async () => {
  const db: Db = createDb(":memory:");
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 500 })) as any;

  const longAgo = Date.now() - 700_000;
  db.raw.run(
    `INSERT INTO webhook_queue (event_id, adapter_id, event_type, payload_json, webhook_url, status, attempt_count, next_attempt_at, first_attempted_at, created_at)
     VALUES ('e2','adp','reply','{}','http://x/hook','pending',3,?,?,?)`,
    [Date.now() - 1, longAgo, longAgo]
  );

  const pub = startPublisher(db, { retry_window_ms: 600_000, backoff_ms: [1000] }, NOOP_LOGGER);
  await pub.tick();
  pub.stop();
  globalThis.fetch = origFetch;

  const row = db.raw.query<{ status: string }, []>("SELECT status FROM webhook_queue WHERE event_id='e2'").get();
  expect(row!.status).toBe("dead_letter");
  db.close();
});
