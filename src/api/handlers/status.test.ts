import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { statusHandler } from "./status";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeTmux } from "../../tmux/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-status";

beforeEach(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

function makeCtx(overrides: Partial<HandlerCtx> = {}): HandlerCtx {
  const db = createDb(":memory:");
  const bus = createEventBus();
  const tmux = createFakeTmux();
  const modeController = createModeController();
  const dispatcher = createDispatcher({ maxConcurrentTurns: 3, tmux, onDispatch: async () => "stub" });
  const config = {
    daemon: { socket_path: "/tmp/x.sock", data_dir: TMP },
    adapters: { test: { webhook_url: "http://x/hook", token: "t1" } },
  } as unknown as ParaRaidConfig;
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

test("status returns mode, dispatcher counts, session breakdown, and ram_mb", async () => {
  const ctx = makeCtx();
  insertSess(ctx, "s1", "live");
  insertSess(ctx, "s2", "live");
  insertSess(ctx, "s3", "launching");
  insertSess(ctx, "s4", "dead");

  const req = new Request("http://x/v1/status", { method: "GET" });
  const res = await statusHandler(req, ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;

  expect(body.mode).toBe("running");
  expect(body.active_turns).toBe(0);
  expect(body.pending_turns).toBe(0);
  expect(body.sessions).toEqual({ live: 2, launching: 1, recovering: 0, closed: 0, dead: 1 });
  expect(typeof body.ram_mb).toBe("number");
  expect(body.ram_mb).toBeGreaterThan(0);
});

test("status reports paused mode after pause()", async () => {
  const ctx = makeCtx();
  ctx.modeController.pause();
  const req = new Request("http://x/v1/status", { method: "GET" });
  const res = await statusHandler(req, ctx, {});
  const body = await res.json() as any;
  expect(body.mode).toBe("paused");
});

test("status is admin-only: a regular adapter is rejected with 403", async () => {
  const ctx = makeCtx({ adapter_id: "test" });
  const req = new Request("http://x/v1/status", { method: "GET" });
  expect(statusHandler(req, ctx, {})).rejects.toThrow(/admin token required/);
});
