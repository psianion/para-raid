import { test, expect } from "bun:test";
import { createRouter, type Route, type HandlerCtx } from "./router";
import { jsonResponse } from "./envelope";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const stubCtx = { logger: NOOP_LOGGER } as unknown as HandlerCtx;

test("router dispatches on method + path", async () => {
  const routes: Route[] = [
    { method: "GET", pattern: /^\/v1\/status$/, handler: async () => jsonResponse(200, { ok: true }) },
  ];
  const router = createRouter(routes, stubCtx);
  const res = await router(new Request("http://x/v1/status"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("router returns 404 for unmatched path", async () => {
  const router = createRouter([], stubCtx);
  const res = await router(new Request("http://x/nope"));
  expect(res.status).toBe(404);
  const body = await res.json() as { error: string };
  expect(body.error).toBe("not_found");
});

test("router extracts dynamic segments via regex groups", async () => {
  let captured: Record<string, string> = {};
  const routes: Route[] = [
    {
      method: "GET",
      pattern: /^\/v1\/sessions\/(?<id>[^/]+)$/,
      handler: async (_req, _ctx, params) => { captured = params; return jsonResponse(200, params); },
    },
  ];
  const router = createRouter(routes, stubCtx);
  const res = await router(new Request("http://x/v1/sessions/abc-123"));
  expect(res.status).toBe(200);
  expect(captured).toEqual({ id: "abc-123" });
});

test("router returns 500 on handler throw", async () => {
  const routes: Route[] = [
    { method: "GET", pattern: /^\/boom$/, handler: async () => { throw new Error("boom"); } },
  ];
  const router = createRouter(routes, stubCtx);
  const res = await router(new Request("http://x/boom"));
  expect(res.status).toBe(500);
});
