import { test, expect, beforeEach } from "bun:test";
import { launchDefaults } from "../../sessions/launcher";
import { recycleSessionHandler } from "./recycle-session";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeRuntime, type FakeRuntime } from "../../worker/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";
import { mkdirSync, rmSync } from "fs";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
launchDefaults.readyGraceMs = 30; // fake workers: no early-exit watch needed
const TMP = "/tmp/pararaid-w56-recycle";

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

function insertLive(ctx: HandlerCtx & { runtime: FakeRuntime }, oldId: string): void {
  mkdirSync(`${TMP}/wd`, { recursive: true });
  ctx.db.raw.run(
    "INSERT INTO sessions (id, adapter_id, adapter_ref, status, cwd, mcp_bundle, webhook_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [oldId, "test", "ref-rcy", "live", `${TMP}/wd`, "", "http://localhost/webhook", Date.now(), Date.now()]
  );
  ctx.runtime.spawn({ sessionId: oldId, cwd: `${TMP}/wd`, mode: "new" });
}

const post = (body: unknown) => new Request("http://x/v1/recycle_session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test("recycle_session returns 404 for unknown session", async () => {
  const ctx = makeCtx();
  const res = await recycleSessionHandler(post({ session_id: "00000000-0000-4000-8000-000000000000" }), ctx, {});
  expect(res.status).toBe(404);
  expect((await res.json() as any).error).toBe("session_not_live");
});

test("recycle_session swaps live row to closed and inserts new live row", async () => {
  const ctx = makeCtx();
  const oldId = "00000000-0000-4000-8000-00000000bbbb";
  insertLive(ctx, oldId);


  const res = await recycleSessionHandler(post({ session_id: oldId }), ctx, {});
  expect(res.status).toBe(202);
  const body = await res.json() as any;
  expect(body.old_session_id).toBe(oldId);
  expect(body.new_session_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(body.new_session_id).not.toBe(oldId);

  const oldRow = ctx.db.raw.query<any, [string]>("SELECT status FROM sessions WHERE id = ?").get(oldId);
  expect(oldRow.status).toBe("closed");
  const newRow = ctx.db.raw.query<any, [string]>("SELECT status, cwd FROM sessions WHERE id = ?").get(body.new_session_id);
  expect(newRow.status).toBe("live");
  expect(newRow.cwd).toBe(`${TMP}/wd`);
  expect(ctx.runtime.workers.get(oldId)!.alive).toBe(false);
  expect(ctx.runtime.workers.get(body.new_session_id)!.alive).toBe(true);
  const ev = ctx.db.raw.query<{ event_type: string }, []>("SELECT event_type FROM webhook_queue").all();
  expect(ev.map(e => e.event_type)).toContain("session_recycled");
});

test("recycle_session returns 403 when a different adapter owns the session", async () => {
  const ctx = makeCtx({ adapter_id: "intruder" });
  const oldId = "00000000-0000-4000-8000-00000000bbbc";
  insertLive(ctx, oldId);
  expect(recycleSessionHandler(post({ session_id: oldId }), ctx, {})).rejects.toThrow(/own this session/);
});
