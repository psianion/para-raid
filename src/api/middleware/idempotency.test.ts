import { test, expect, beforeEach } from "bun:test";
import { withIdempotencyMiddleware } from "./idempotency";
import { jsonResponse } from "../envelope";
import { createDb } from "../../db";
import type { HandlerCtx } from "../router";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;

test("idempotency replays cached response on key match", async () => {
  const db = createDb(":memory:");
  let calls = 0;
  const handler = withIdempotencyMiddleware(async () => { calls++; return jsonResponse(200, { ok: true, calls }); });
  const ctx = { db, logger: NOOP_LOGGER, adapter_id: "a" } as unknown as HandlerCtx;
  const req1 = new Request("http://x/v1/open_session", { method: "POST", headers: { "Idempotency-Key": "k1" } });
  const req2 = new Request("http://x/v1/open_session", { method: "POST", headers: { "Idempotency-Key": "k1" } });
  const r1 = await handler(req1, ctx, {});
  const r2 = await handler(req2, ctx, {});
  expect(r1.status).toBe(200);
  expect(r2.status).toBe(200);
  expect(r2.headers.get("X-Idempotency-Replay")).toBe("true");
  expect(calls).toBe(1);
  db.close();
});

test("idempotency does not affect GET requests", async () => {
  const db = createDb(":memory:");
  let calls = 0;
  const handler = withIdempotencyMiddleware(async () => { calls++; return jsonResponse(200, { ok: true }); });
  const ctx = { db, logger: NOOP_LOGGER, adapter_id: "a" } as unknown as HandlerCtx;
  await handler(new Request("http://x/v1/status", { method: "GET" }), ctx, {});
  await handler(new Request("http://x/v1/status", { method: "GET" }), ctx, {});
  expect(calls).toBe(2);
  db.close();
});

test("idempotency does not cache non-2xx responses", async () => {
  const db = createDb(":memory:");
  let calls = 0;
  const handler = withIdempotencyMiddleware(async () => { calls++; return jsonResponse(400, { error: "bad" }); });
  const ctx = { db, logger: NOOP_LOGGER, adapter_id: "a" } as unknown as HandlerCtx;
  const req = new Request("http://x/v1/open_session", { method: "POST", headers: { "Idempotency-Key": "k2" } });
  await handler(req, ctx, {});
  await handler(req, ctx, {});
  expect(calls).toBe(2);
  db.close();
});
