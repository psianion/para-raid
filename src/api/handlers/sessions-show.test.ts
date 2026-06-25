import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { sessionsShowHandler } from "./sessions-show";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeTmux } from "../../tmux/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-sessshow";

beforeEach(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

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
    adapter_id: "test", // owner of the seeded session in these tests
    ...overrides,
  };
}

function seedSession(ctx: HandlerCtx, sid: string): void {
  const now = Date.now();
  ctx.db.raw.run(
    `INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [sid, "test", "ref-1", "live", "tmx-1", `${TMP}/nope-${sid}`, "", "http://x/hook", now, now],
  );
}

test("sessions_show returns the session, latest_turn, and transcript_path (null when no transcript)", async () => {
  const ctx = makeCtx();
  const sid = "11111111-1111-4111-8111-111111111111";
  const now = Date.now();
  ctx.db.raw.run(
    `INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [sid, "test", "ref-1", "live", "tmx-1", `${TMP}/nope-${sid}`, "", "http://x/hook", now, now],
  );
  ctx.db.raw.run(
    `INSERT INTO turns (id, session_id, status, prompt_sha256, created_at) VALUES (?,?,?,?,?)`,
    ["t1", sid, "queued", "abc", now - 1000],
  );
  ctx.db.raw.run(
    `INSERT INTO turns (id, session_id, status, prompt_sha256, created_at) VALUES (?,?,?,?,?)`,
    ["t2", sid, "completed", "def", now],
  );

  const req = new Request(`http://x/v1/sessions/${sid}`, { method: "GET" });
  const res = await sessionsShowHandler(req, ctx, { id: sid });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.session.id).toBe(sid);
  expect(body.latest_turn.id).toBe("t2");
  expect(body.transcript_path).toBeNull();
});

test("sessions_show returns 404 not_found for unknown id", async () => {
  const ctx = makeCtx();
  const req = new Request("http://x/v1/sessions/missing", { method: "GET" });
  const res = await sessionsShowHandler(req, ctx, { id: "missing" });
  expect(res.status).toBe(404);
  const body = await res.json() as any;
  expect(body.error).toBe("not_found");
});

test("sessions_show forbids a different adapter from reading the session", async () => {
  const ctx = makeCtx({ adapter_id: "intruder" });
  const sid = "22222222-2222-4222-8222-222222222222";
  seedSession(ctx, sid); // owned by adapter 'test'
  const req = new Request(`http://x/v1/sessions/${sid}`, { method: "GET" });
  expect(sessionsShowHandler(req, ctx, { id: sid })).rejects.toThrow(/own this session/);
});

test("sessions_show allows admin to read any session", async () => {
  const ctx = makeCtx({ adapter_id: "__admin__" });
  const sid = "33333333-3333-4333-8333-333333333333";
  seedSession(ctx, sid);
  const req = new Request(`http://x/v1/sessions/${sid}`, { method: "GET" });
  const res = await sessionsShowHandler(req, ctx, { id: sid });
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.session.id).toBe(sid);
});
