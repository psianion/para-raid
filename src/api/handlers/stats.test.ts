import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { statsHandler, __statsHooks } from "./stats";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeTmux } from "../../tmux/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-stats";

const ORIG_PS = __statsHooks.psRssKb;
const ORIG_DU = __statsHooks.duBytes;
const ORIG_PID = __statsHooks.pidFor;

beforeEach(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  __statsHooks.psRssKb = ORIG_PS;
  __statsHooks.duBytes  = ORIG_DU;
  __statsHooks.pidFor   = ORIG_PID;
});

function makeCtx(overrides: Partial<HandlerCtx> = {}): HandlerCtx {
  const db = createDb(":memory:");
  const bus = createEventBus();
  const tmux = createFakeTmux();
  const modeController = createModeController();
  const dispatcher = createDispatcher({ maxConcurrentTurns: 3, tmux, onDispatch: async () => "stub" });
  const config = { daemon: { socket_path: "/tmp/x.sock", data_dir: TMP }, adapters: {} } as unknown as ParaRaidConfig;
  return {
    db, bus, tmux, modeController, dispatcher, config,
    logger: NOOP_LOGGER, hookEventsPath: `${TMP}/hook-events.jsonl`,
    adapter_id: "__admin__",
    ...overrides,
  };
}

function insertSess(ctx: HandlerCtx, id: string, status: string): void {
  const now = Date.now();
  ctx.db.raw.run(
    `INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, "test", `ref-${id}`, status, `tmx-${id}`, `/tmp/cwd-${id}`, "", "http://x/hook", now, now],
  );
}

test("stats aggregates per-session RSS via test seam and reports daemon ram", async () => {
  const ctx = makeCtx();
  insertSess(ctx, "s1", "live");
  insertSess(ctx, "s2", "launching");
  insertSess(ctx, "s3", "closed"); // excluded

  __statsHooks.pidFor   = async (id: string) => id === "s1" ? 1234 : id === "s2" ? 5678 : null;
  __statsHooks.psRssKb  = async (pid: number) => pid === 1234 ? 10240 : pid === 5678 ? 20480 : null; // 10MB + 20MB
  __statsHooks.duBytes  = async () => 4096;

  const req = new Request("http://x/v1/stats", { method: "GET" });
  const res = await statsHandler(req, ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;

  expect(body.sessions.length).toBe(2);
  const byId: Record<string, any> = {};
  for (const s of body.sessions) byId[s.id] = s;
  expect(byId.s1.rss_mb).toBe(10);
  expect(byId.s2.rss_mb).toBe(20);
  expect(byId.s1.workdir_bytes).toBe(4096);
  expect(body.total_session_rss_mb).toBe(30);
  expect(typeof body.daemon_rss_mb).toBe("number");
});

test("stats tolerates missing pid / spawn failure (returns null fields, not 500)", async () => {
  const ctx = makeCtx();
  insertSess(ctx, "s1", "live");

  __statsHooks.pidFor  = async () => null;       // no pid → no ps
  __statsHooks.duBytes = async () => null;       // du failed

  const req = new Request("http://x/v1/stats", { method: "GET" });
  const res = await statsHandler(req, ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.sessions[0].rss_mb).toBeNull();
  expect(body.sessions[0].workdir_bytes).toBeNull();
  expect(body.total_session_rss_mb).toBe(0);
});

test("stats is admin-only: a regular adapter is rejected with 403", async () => {
  const ctx = makeCtx({ adapter_id: "test" });
  const req = new Request("http://x/v1/stats", { method: "GET" });
  expect(statsHandler(req, ctx, {})).rejects.toThrow(/admin token required/);
});
