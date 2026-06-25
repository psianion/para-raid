import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { sessionsListHandler } from "./sessions-list";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeTmux } from "../../tmux/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-sesslist";

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
    adapter_id: "__admin__",
    ...overrides,
  };
}

function insertSess(ctx: HandlerCtx, id: string, adapter_id: string, status: string, created_at: number): void {
  ctx.db.raw.run(
    `INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, adapter_id, `ref-${id}`, status, `tmx-${id}`, `/tmp/cwd-${id}`, "", "http://x/hook", created_at, created_at],
  );
}

test("sessions_list returns sessions ordered by created_at DESC with default limit", async () => {
  const ctx = makeCtx();
  insertSess(ctx, "s1", "test", "live", 1000);
  insertSess(ctx, "s2", "test", "live", 2000);
  insertSess(ctx, "s3", "test", "live", 3000);

  const req = new Request("http://x/v1/sessions", { method: "GET" });
  const res = await sessionsListHandler(req, ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.sessions.map((s: any) => s.id)).toEqual(["s3", "s2", "s1"]);
  expect(body.next_cursor).toBeNull();
});

test("sessions_list filters by adapter_id and status", async () => {
  const ctx = makeCtx();
  insertSess(ctx, "s1", "test", "live", 1000);
  insertSess(ctx, "s2", "test", "dead", 2000);
  insertSess(ctx, "s3", "other", "live", 3000);

  const req = new Request("http://x/v1/sessions?adapter_id=test&status=live", { method: "GET" });
  const res = await sessionsListHandler(req, ctx, {});
  const body = await res.json() as any;
  expect(body.sessions.length).toBe(1);
  expect(body.sessions[0].id).toBe("s1");
});

test("sessions_list paginates via cursor and limit and returns next_cursor when full page", async () => {
  const ctx = makeCtx();
  for (let i = 1; i <= 5; i++) insertSess(ctx, `s${i}`, "test", "live", i * 1000);

  const req1 = new Request("http://x/v1/sessions?limit=2", { method: "GET" });
  const res1 = await sessionsListHandler(req1, ctx, {});
  const body1 = await res1.json() as any;
  expect(body1.sessions.map((s: any) => s.id)).toEqual(["s5", "s4"]);
  expect(body1.next_cursor).toBe(4000);

  const req2 = new Request(`http://x/v1/sessions?limit=2&cursor=${body1.next_cursor}`, { method: "GET" });
  const res2 = await sessionsListHandler(req2, ctx, {});
  const body2 = await res2.json() as any;
  expect(body2.sessions.map((s: any) => s.id)).toEqual(["s3", "s2"]);
  expect(body2.next_cursor).toBe(2000);
});

test("sessions_list scopes a regular adapter to its own rows, ignoring the query param", async () => {
  const ctx = makeCtx({ adapter_id: "test" });
  insertSess(ctx, "s1", "test", "live", 1000);
  insertSess(ctx, "s2", "other", "live", 2000);

  // Even if the caller asks for adapter_id=other, it only sees its own ('test').
  const req = new Request("http://x/v1/sessions?adapter_id=other", { method: "GET" });
  const res = await sessionsListHandler(req, ctx, {});
  const body = await res.json() as any;
  expect(body.sessions.map((s: any) => s.id)).toEqual(["s1"]);
});
