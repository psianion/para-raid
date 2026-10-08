import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { statsHandler, __statsHooks } from "./stats";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeRuntime, type FakeRuntime } from "../../worker/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-stats";

const ORIG_PS = __statsHooks.psRssKb;
const ORIG_DU = __statsHooks.duBytes;

beforeEach(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  __statsHooks.psRssKb = ORIG_PS;
  __statsHooks.duBytes  = ORIG_DU;
});

function makeCtx(overrides: Partial<HandlerCtx> = {}): HandlerCtx & { runtime: FakeRuntime } {
  const db = createDb(":memory:");
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  const modeController = createModeController();
  const dispatcher = createDispatcher({ maxConcurrentTurns: 3, onDispatch: async () => "stub" });
  const config = { daemon: { socket_path: "/tmp/x.sock", data_dir: TMP }, adapters: {} } as unknown as ParaRaidConfig;
  return { db, bus, runtime, modeController, dispatcher, config, logger: NOOP_LOGGER, adapter_id: "__admin__", ...overrides } as HandlerCtx & { runtime: FakeRuntime };
}

function insertSess(ctx: HandlerCtx, id: string, status: string): void {
  const now = Date.now();
  ctx.db.raw.run(
    `INSERT INTO sessions (id, adapter_id, adapter_ref, status, cwd, mcp_bundle, webhook_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, "test", `ref-${id}`, status, `/tmp/cwd-${id}`, "", "http://x/hook", now, now],
  );
}

test("stats aggregates per-session RSS from live worker pids via the test seam and reports daemon ram", async () => {
  const ctx = makeCtx();
  insertSess(ctx, "s1", "live");
  insertSess(ctx, "s2", "launching");
  insertSess(ctx, "s3", "closed"); // excluded
  ctx.runtime.spawn({ sessionId: "s1", cwd: "/tmp/cwd-s1", mode: "new" }); // fake pid 12345
  ctx.runtime.spawn({ sessionId: "s2", cwd: "/tmp/cwd-s2", mode: "new" });

  let calls = 0;
  __statsHooks.psRssKb  = async (pid: number) => { calls++; return pid === 12345 ? 10240 : null; }; // 10MB each
  __statsHooks.duBytes  = async () => 4096;

  const res = await statsHandler(new Request("http://x/v1/stats"), ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;

  expect(body.sessions.length).toBe(2);
  const byId: Record<string, any> = {};
  for (const s of body.sessions) byId[s.id] = s;
  expect(byId.s1.pid).toBe(12345);
  expect(byId.s1.rss_mb).toBe(10);
  expect(byId.s2.rss_mb).toBe(10);
  expect(byId.s1.workdir_bytes).toBe(4096);
  expect(body.total_session_rss_mb).toBe(20);
  expect(calls).toBe(2);
  expect(typeof body.daemon_rss_mb).toBe("number");
});

test("stats tolerates a session without a worker and du failure (null fields, not 500)", async () => {
  const ctx = makeCtx();
  insertSess(ctx, "s1", "recovering"); // no worker process
  __statsHooks.psRssKb = async () => { throw new Error("must not be called without a pid"); };
  __statsHooks.duBytes = async () => null;       // du failed

  const res = await statsHandler(new Request("http://x/v1/stats"), ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.sessions[0].pid).toBeNull();
  expect(body.sessions[0].rss_mb).toBeNull();
  expect(body.sessions[0].workdir_bytes).toBeNull();
  expect(body.total_session_rss_mb).toBe(0);
});

test("stats is admin-only: a regular adapter is rejected with 403", async () => {
  const ctx = makeCtx({ adapter_id: "test" });
  expect(statsHandler(new Request("http://x/v1/stats"), ctx, {})).rejects.toThrow(/admin token required/);
});
