import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { sendTurnHandler } from "./send-turn";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeTmux } from "../../tmux/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-send";

beforeEach(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

function makeCtx(overrides: Partial<HandlerCtx> = {}): HandlerCtx {
  const db = createDb(":memory:");
  const bus = createEventBus();
  const tmux = createFakeTmux();
  const modeController = createModeController();
  const dispatcher = createDispatcher({
    maxConcurrentTurns: 3,
    tmux,
    onDispatch: async () => "stub-reply",
  });
  const config = {
    daemon: { data_dir: TMP, hook_events_path: `${TMP}/hook-events.jsonl`, socket_path: "/tmp/x.sock" },
    concurrency: { max_concurrent_turns: 3, max_total_sessions: 10 },
    recovery: { grace_window_ms: 600_000 },
    publisher: { retry_window_ms: 600_000, backoff_ms: [1000] },
    limit: { warning_regex: "approaching" },
    auth: "none", signing: "none",
    adapters: { test: { webhook_url: "http://x/hook" } },
  } as unknown as ParaRaidConfig;
  return {
    db, bus, tmux, modeController, dispatcher, config,
    logger: NOOP_LOGGER,
    hookEventsPath: `${TMP}/hook-events.jsonl`,
    adapter_id: "test",
    ...overrides,
  };
}

function insertLiveSession(ctx: HandlerCtx, id: string): void {
  const now = Date.now();
  ctx.db.raw.run(
    `INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, "test", `ref-${id}`, "live", `tmx-${id}`, `${TMP}/cwd-${id}`, "", "http://x/hook", now, now],
  );
}

test("send_turn returns 202, INSERTs a turns row, and enqueues turn_replied", async () => {
  const ctx = makeCtx();
  const sid = "11111111-1111-4111-8111-111111111111";
  insertLiveSession(ctx, sid);

  const req = new Request("http://x/v1/send_turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sid, prompt: "hello" }),
  });
  const res = await sendTurnHandler(req, ctx, {});
  expect(res.status).toBe(202);
  const body = await res.json() as any;
  expect(body.session_id).toBe(sid);
  expect(typeof body.turn_id).toBe("string");

  // turns row exists with prompt_sha256 (NOT prompt — Wave 1 schema)
  const turn = ctx.db.raw.query<{ id: string; status: string; prompt_sha256: string }, [string]>(
    "SELECT id, status, prompt_sha256 FROM turns WHERE id = ?",
  ).get(body.turn_id) as { id: string; status: string; prompt_sha256: string } | null;
  expect(turn).not.toBeNull();
  expect(turn!.prompt_sha256.length).toBe(64);

  // Wait for the async dispatch + webhook insert to settle.
  await new Promise(r => setTimeout(r, 50));

  const wh = ctx.db.raw.query<{ event_type: string; payload_json: string }, [string]>(
    "SELECT event_type, payload_json FROM webhook_queue WHERE session_id = ? AND event_type = 'turn_replied' LIMIT 1",
  ).get(sid) as { event_type: string; payload_json: string } | null;
  expect(wh).not.toBeNull();
  const payload = JSON.parse(wh!.payload_json);
  expect(payload.turn_id).toBe(body.turn_id);
  expect(payload.reply).toBe("stub-reply");
});

test("send_turn returns 404 session_not_live for unknown or non-live sessions", async () => {
  const ctx = makeCtx();
  // Insert a session in 'closed' state — must still be rejected.
  const closedId = "22222222-2222-4222-8222-222222222222";
  ctx.db.raw.run(
    `INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [closedId, "test", "ref-closed", "closed", "tmx-c", `${TMP}/c`, "", "http://x/hook", Date.now(), Date.now()],
  );

  const req = new Request("http://x/v1/send_turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: closedId, prompt: "hi" }),
  });
  const res = await sendTurnHandler(req, ctx, {});
  expect(res.status).toBe(404);
  const body = await res.json() as any;
  expect(body.error).toBe("session_not_live");
});

test("send_turn returns 403 when a different adapter tries to drive the session", async () => {
  const ctx = makeCtx({ adapter_id: "intruder" });
  const sid = "11111111-1111-4111-8111-111111111112";
  insertLiveSession(ctx, sid); // seeded with adapter_id 'test'
  const req = new Request("http://x/v1/send_turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sid, prompt: "mine now" }),
  });
  expect(sendTurnHandler(req, ctx, {})).rejects.toThrow(/own this session/);
});

test("send_turn allows admin to drive any session", async () => {
  const ctx = makeCtx({ adapter_id: "__admin__" });
  const sid = "11111111-1111-4111-8111-111111111113";
  insertLiveSession(ctx, sid);
  const req = new Request("http://x/v1/send_turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sid, prompt: "admin turn" }),
  });
  const res = await sendTurnHandler(req, ctx, {});
  expect(res.status).toBe(202);
});
