import { test, expect } from "bun:test";
import { withAuthMiddleware } from "./auth";
import { jsonResponse } from "../envelope";
import { ADMIN_ID, type HandlerCtx } from "../router";

const ADMIN = "s3cret-admin-0123456789abcdef";
const A_TOKEN = "adapter-a-token-0123456789abcdef";
const B_TOKEN = "adapter-b-token-0123456789abcdef";

function ctxWith(auth: { mode: string; token?: string }, adapters: Record<string, { webhook_url: string; token: string }> = {}): HandlerCtx {
  return { config: { auth, adapters }, requestId: "req-1" } as unknown as HandlerCtx;
}

const ADAPTERS = {
  a: { webhook_url: "http://x/a", token: A_TOKEN },
  b: { webhook_url: "http://x/b", token: B_TOKEN },
};

test("auth mode none lets the request through and is treated as admin", async () => {
  let seen: string | undefined;
  const h = withAuthMiddleware(async (_r, ctx) => { seen = ctx.adapter_id; return jsonResponse(200, { ok: true }); });
  const r = await h(new Request("http://x/v1/status"), ctxWith({ mode: "none" }), {});
  expect(r.status).toBe(200);
  expect(seen).toBe(ADMIN_ID);
});

test("auth mode bearer rejects a missing token with 401 unauthorized", async () => {
  let called = 0;
  const h = withAuthMiddleware(async () => { called++; return jsonResponse(200, {}); });
  const r = await h(new Request("http://x/v1/status"), ctxWith({ mode: "bearer", token: ADMIN }, ADAPTERS), {});
  expect(r.status).toBe(401);
  expect(called).toBe(0);
  expect((await r.json()).error).toBe("unauthorized");
});

test("auth mode bearer rejects a token that matches neither admin nor any adapter with 401", async () => {
  let called = 0;
  const h = withAuthMiddleware(async () => { called++; return jsonResponse(200, {}); });
  const req = new Request("http://x/v1/status", { headers: { Authorization: "Bearer wrong-token-zzzz" } });
  const r = await h(req, ctxWith({ mode: "bearer", token: ADMIN }, ADAPTERS), {});
  expect(r.status).toBe(401);
  expect(called).toBe(0);
});

test("the global token derives the admin identity", async () => {
  let seen: string | undefined;
  const h = withAuthMiddleware(async (_r, ctx) => { seen = ctx.adapter_id; return jsonResponse(200, { ok: true }); });
  const req = new Request("http://x/v1/status", { headers: { Authorization: `Bearer ${ADMIN}` } });
  const r = await h(req, ctxWith({ mode: "bearer", token: ADMIN }, ADAPTERS), {});
  expect(r.status).toBe(200);
  expect(seen).toBe(ADMIN_ID);
});

test("a per-adapter token derives that adapter's identity (not from any header)", async () => {
  let seen: string | undefined;
  const h = withAuthMiddleware(async (_r, ctx) => { seen = ctx.adapter_id; return jsonResponse(200, { ok: true }); });
  // Spoofed X-Adapter-Id must be ignored — identity comes from the token (b).
  const req = new Request("http://x/v1/status", { headers: { Authorization: `Bearer ${B_TOKEN}`, "X-Adapter-Id": "a" } });
  const r = await h(req, ctxWith({ mode: "bearer", token: ADMIN }, ADAPTERS), {});
  expect(r.status).toBe(200);
  expect(seen).toBe("b");
});
