import { test, expect, beforeEach } from "bun:test";
import { closeSessionHandler } from "./close-session";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeRuntime, type FakeRuntime } from "../../worker/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";
import { existsSync, mkdirSync, rmSync } from "fs";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-close";

beforeEach(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });

function makeCtx(overrides: Partial<HandlerCtx> = {}): HandlerCtx & { runtime: FakeRuntime } {
  const db = createDb(":memory:");
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  const modeController = createModeController();
  const dispatcher = createDispatcher({
    maxConcurrentTurns: 3,
    onDispatch: async () => "stub-reply",
  });
  const config = {
    daemon: { data_dir: TMP, socket_path: "/tmp/x.sock" },
    concurrency: { max_concurrent_turns: 3, max_total_sessions: 10 },
    recovery: { grace_window_ms: 600_000 },
    publisher: { retry_window_ms: 600_000, backoff_ms: [1000] },
    limit: { warning_regex: "approaching" },
    auth: "none", signing: "none",
    adapters: { test: { webhook_url: "http://x/hook" } },
  } as unknown as ParaRaidConfig;
  return { db, bus, runtime, modeController, dispatcher, config, logger: NOOP_LOGGER, adapter_id: "test", ...overrides } as HandlerCtx & { runtime: FakeRuntime };
}

function insertLive(ctx: HandlerCtx & { runtime: FakeRuntime }, sessionId: string): void {
  ctx.db.raw.run(
    "INSERT INTO sessions (id, adapter_id, adapter_ref, status, cwd, mcp_bundle, webhook_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [sessionId, "test", "ref-close", "live", `${TMP}/wd`, "", "http://localhost/webhook", Date.now(), Date.now()]
  );
  mkdirSync(`${TMP}/wd`, { recursive: true });
  ctx.runtime.spawn({ sessionId, cwd: `${TMP}/wd`, mode: "new" });
}

const post = (body: unknown) => new Request("http://x/v1/close_session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function waitFor(fn: () => boolean, ms = 2_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("waitFor timeout");
}

test("close_session returns 200 closing, then closes the worker, removes the workdir and marks the row closed", async () => {
  const ctx = makeCtx();
  const sessionId = "00000000-0000-4000-8000-00000000aaaa";
  insertLive(ctx, sessionId);

  const res = await closeSessionHandler(post({ session_id: sessionId }), ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.status).toBe("closing");
  expect(body.session_id).toBe(sessionId);

  await waitFor(() => ctx.db.raw.query<{ status: string }, [string]>("SELECT status FROM sessions WHERE id = ?").get(sessionId)?.status === "closed");
  const w = ctx.runtime.workers.get(sessionId)!;
  expect(w.ended).toBe(true);
  expect(w.alive).toBe(false);
  expect(existsSync(`${TMP}/wd`)).toBe(false);
  const ev = ctx.db.raw.query<{ event_type: string }, []>("SELECT event_type FROM webhook_queue").all();
  expect(ev.map((e) => e.event_type)).toContain("session_closed");
});

test("close_session returns 404 for unknown session", async () => {
  const ctx = makeCtx();
  const res = await closeSessionHandler(post({ session_id: "00000000-0000-4000-8000-000000000000" }), ctx, {});
  expect(res.status).toBe(404);
  expect((await res.json() as any).error).toBe("not_found");
});

test("close_session returns 403 when a different adapter owns the session", async () => {
  const ctx = makeCtx({ adapter_id: "intruder" });
  const sessionId = "00000000-0000-4000-8000-00000000acdc";
  insertLive(ctx, sessionId);
  expect(closeSessionHandler(post({ session_id: sessionId }), ctx, {})).rejects.toThrow(/own this session/);
});
