import { test, expect } from "bun:test";
import { withAuthMiddleware } from "./auth";
import { jsonResponse } from "../envelope";
import type { HandlerCtx } from "../router";

const TOKEN = "s3cret-token-0123456789abcdef";

function ctxWith(auth: { mode: string; token?: string }): HandlerCtx {
  return { config: { auth }, requestId: "req-1" } as unknown as HandlerCtx;
}

test("auth mode none lets the request through", async () => {
  let called = 0;
  const h = withAuthMiddleware(async () => { called++; return jsonResponse(200, { ok: true }); });
  const r = await h(new Request("http://x/v1/status"), ctxWith({ mode: "none" }), {});
  expect(r.status).toBe(200);
  expect(called).toBe(1);
});

test("auth mode bearer rejects a missing token with 401 unauthorized", async () => {
  let called = 0;
  const h = withAuthMiddleware(async () => { called++; return jsonResponse(200, {}); });
  const r = await h(new Request("http://x/v1/status"), ctxWith({ mode: "bearer", token: TOKEN }), {});
  expect(r.status).toBe(401);
  expect(called).toBe(0);
  expect((await r.json()).error).toBe("unauthorized");
});

test("auth mode bearer rejects a wrong token with 401", async () => {
  let called = 0;
  const h = withAuthMiddleware(async () => { called++; return jsonResponse(200, {}); });
  const req = new Request("http://x/v1/status", { headers: { Authorization: "Bearer wrong-token-zzzz" } });
  const r = await h(req, ctxWith({ mode: "bearer", token: TOKEN }), {});
  expect(r.status).toBe(401);
  expect(called).toBe(0);
});

test("auth mode bearer accepts the correct token", async () => {
  let called = 0;
  const h = withAuthMiddleware(async () => { called++; return jsonResponse(200, { ok: true }); });
  const req = new Request("http://x/v1/status", { headers: { Authorization: `Bearer ${TOKEN}` } });
  const r = await h(req, ctxWith({ mode: "bearer", token: TOKEN }), {});
  expect(r.status).toBe(200);
  expect(called).toBe(1);
});
