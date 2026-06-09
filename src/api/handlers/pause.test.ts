import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { pauseHandler } from "./pause";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeTmux } from "../../tmux/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-pause";

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
    adapters: { test: { webhook_url: "http://x/hook" }, other: { webhook_url: "http://y/hook" } },
  } as unknown as ParaRaidConfig;
  return {
    db, bus, tmux, modeController, dispatcher, config,
    logger: NOOP_LOGGER, hookEventsPath: `${TMP}/hook-events.jsonl`,
    ...overrides,
  };
}

test("pause flips mode to paused and returns { mode: paused }", async () => {
  const ctx = makeCtx();
  expect(ctx.modeController.isPaused()).toBe(false);
  const req = new Request("http://x/v1/pause", { method: "POST", headers: { "Content-Type": "application/json", "X-Adapter-Id": "test" }, body: "{}" });
  const res = await pauseHandler(req, ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.mode).toBe("paused");
  expect(ctx.modeController.isPaused()).toBe(true);

  // mode-changed webhooks enqueued for both adapters
  const rows = ctx.db.raw.query<{ adapter_id: string; event_type: string }, []>(
    "SELECT adapter_id, event_type FROM webhook_queue WHERE event_type = 'paused' ORDER BY adapter_id",
  ).all() as Array<{ adapter_id: string; event_type: string }>;
  expect(rows.length).toBe(2);
  expect(rows.map(r => r.adapter_id).sort()).toEqual(["other", "test"]);
});

test("pause is idempotent: second call does not enqueue duplicate webhooks", async () => {
  const ctx = makeCtx();
  const req1 = new Request("http://x/v1/pause", { method: "POST", headers: { "Content-Type": "application/json", "X-Adapter-Id": "test" }, body: "{}" });
  const req2 = new Request("http://x/v1/pause", { method: "POST", headers: { "Content-Type": "application/json", "X-Adapter-Id": "test" }, body: "{}" });
  await pauseHandler(req1, ctx, {});
  await pauseHandler(req2, ctx, {});
  const n = ctx.db.raw.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM webhook_queue WHERE event_type = 'paused'",
  ).get() as { n: number };
  expect(n.n).toBe(2); // 2 adapters once, not 4
});
