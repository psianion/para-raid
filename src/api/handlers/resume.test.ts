import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { resumeHandler } from "./resume";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeTmux } from "../../tmux/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-resumemode";

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

test("resume flips mode to running and emits resumed webhook when previously paused", async () => {
  const ctx = makeCtx();
  ctx.modeController.pause();
  const req = new Request("http://x/v1/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const res = await resumeHandler(req, ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.mode).toBe("running");
  expect(ctx.modeController.isPaused()).toBe(false);

  const rows = ctx.db.raw.query<{ event_type: string }, []>(
    "SELECT event_type FROM webhook_queue WHERE event_type = 'resumed'",
  ).all() as Array<{ event_type: string }>;
  expect(rows.length).toBe(1);
});

test("resume is a no-op (no webhook) when daemon was already running", async () => {
  const ctx = makeCtx();
  expect(ctx.modeController.isPaused()).toBe(false);
  const req = new Request("http://x/v1/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const res = await resumeHandler(req, ctx, {});
  expect(res.status).toBe(200);
  const n = ctx.db.raw.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM webhook_queue WHERE event_type = 'resumed'",
  ).get() as { n: number };
  expect(n.n).toBe(0);
});

test("resume is admin-only: a regular adapter is rejected with 403", async () => {
  const ctx = makeCtx({ adapter_id: "test" });
  ctx.modeController.pause();
  const req = new Request("http://x/v1/resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  expect(resumeHandler(req, ctx, {})).rejects.toThrow(/admin token required/);
  expect(ctx.modeController.isPaused()).toBe(true);
});
