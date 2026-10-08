import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { cancelTurnHandler } from "./cancel-turn";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeRuntime, type FakeRuntime } from "../../worker/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-cancel";

beforeEach(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

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

function insertLiveSession(ctx: HandlerCtx & { runtime: FakeRuntime }, id: string): void {
  const now = Date.now();
  ctx.db.raw.run(
    `INSERT INTO sessions (id, adapter_id, adapter_ref, status, cwd, mcp_bundle, webhook_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, "test", `ref-${id}`, "live", `${TMP}/cwd-${id}`, "", "http://x/hook", now, now],
  );
  ctx.runtime.spawn({ sessionId: id, cwd: `${TMP}/cwd-${id}`, mode: "new" });
}

const post = (body: unknown) => new Request("http://x/v1/cancel_turn", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test("cancel_turn interrupts the worker and returns cancelled=true with the partial text once the aborted result lands", async () => {
  const ctx = makeCtx();
  const sid = "33333333-3333-4333-8333-333333333333";
  const turnId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  insertLiveSession(ctx, sid);
  ctx.db.raw.run("INSERT INTO turns (id, session_id, status, prompt_sha256, created_at) VALUES (?,?,?,?,?)", [turnId, sid, "dispatching", "x", Date.now()]);
  ctx.runtime.emitAssistant(sid, "so far");

  // claude answers an interrupt with an aborted result; emit it shortly after
  // the handler subscribes (cancelTurn waits up to 5s by default).
  setTimeout(() => ctx.runtime.emitResult(sid, "", { subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" }), 50);

  const res = await cancelTurnHandler(post({ session_id: sid, turn_id: turnId }), ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.cancelled).toBe(true);
  expect(body.escalated_to_signal).toBe(false);
  expect(body.partial_text).toBe("so far");

  const w = ctx.runtime.workers.get(sid)!;
  expect(w.interrupts).toBe(1);
  expect(w.killed).toEqual([]);

  const turn = ctx.db.raw.query<{ status: string }, [string]>("SELECT status FROM turns WHERE id = ?").get(turnId);
  expect(turn?.status).toBe("cancelled");

  const wh = ctx.db.raw.query<{ payload_json: string }, [string]>(
    "SELECT payload_json FROM webhook_queue WHERE session_id = ? AND event_type = 'turn_cancelled' LIMIT 1",
  ).get(sid) as { payload_json: string } | null;
  expect(wh).not.toBeNull();
  const payload = JSON.parse(wh!.payload_json);
  expect(payload.cancelled).toBe(true);
  expect(payload.turn_id).toBe(turnId);
}, 10_000);

test("cancel_turn returns 404 session_not_live for unknown session", async () => {
  const ctx = makeCtx();
  const res = await cancelTurnHandler(post({ session_id: "44444444-4444-4444-8444-444444444444" }), ctx, {});
  expect(res.status).toBe(404);
  expect((await res.json() as any).error).toBe("session_not_live");
});

test("cancel_turn returns 403 when a different adapter owns the session", async () => {
  const ctx = makeCtx({ adapter_id: "intruder" });
  const sid = "33333333-3333-4333-8333-333333333334";
  insertLiveSession(ctx, sid); // seeded with adapter_id 'test'
  expect(cancelTurnHandler(post({ session_id: sid }), ctx, {})).rejects.toThrow(/own this session/);
});
