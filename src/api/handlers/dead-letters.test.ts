import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { deadLettersListHandler, deadLettersAckHandler } from "./dead-letters";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeTmux } from "../../tmux/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-deadletters";

beforeEach(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

function makeCtx(overrides: Partial<HandlerCtx> = {}): HandlerCtx {
  const db = createDb(":memory:");
  const bus = createEventBus();
  const tmux = createFakeTmux();
  const modeController = createModeController();
  const dispatcher = createDispatcher({ maxConcurrentTurns: 3, tmux, onDispatch: async () => "stub" });
  const config = { daemon: { socket_path: "/tmp/x.sock", data_dir: TMP }, adapters: { test: { webhook_url: "http://x/hook", token: "t1" } } } as unknown as ParaRaidConfig;
  return {
    db, bus, tmux, modeController, dispatcher, config,
    logger: NOOP_LOGGER, hookEventsPath: `${TMP}/hook-events.jsonl`,
    adapter_id: "__admin__",
    ...overrides,
  };
}

function insertEvent(ctx: HandlerCtx, eventId: string, adapter_id: string, status: string, created_at: number): void {
  ctx.db.raw.run(
    `INSERT INTO webhook_queue (event_id, session_id, adapter_id, event_type, payload_json, webhook_url, status, attempt_count, next_attempt_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [eventId, null, adapter_id, "reply", "{}", "http://x/hook", status, 5, created_at, created_at],
  );
}

test("dead_letters_list returns only dead_letter rows, optionally filtered by adapter_id", async () => {
  const ctx = makeCtx();
  insertEvent(ctx, "e1", "test",  "dead_letter", 1000);
  insertEvent(ctx, "e2", "other", "dead_letter", 2000);
  insertEvent(ctx, "e3", "test",  "delivered",   3000);
  insertEvent(ctx, "e4", "test",  "pending",     4000);

  const reqAll = new Request("http://x/v1/dead_letters", { method: "GET" });
  const resAll = await deadLettersListHandler(reqAll, ctx, {});
  expect(resAll.status).toBe(200);
  const bodyAll = await resAll.json() as any;
  expect(bodyAll.dead_letters.map((r: any) => r.event_id).sort()).toEqual(["e1", "e2"]);

  const reqFiltered = new Request("http://x/v1/dead_letters?adapter_id=test", { method: "GET" });
  const resFiltered = await deadLettersListHandler(reqFiltered, ctx, {});
  const bodyFiltered = await resFiltered.json() as any;
  expect(bodyFiltered.dead_letters.length).toBe(1);
  expect(bodyFiltered.dead_letters[0].event_id).toBe("e1");
});

test("dead_letters_ack flips dead_letter rows to delivered for the given event_ids", async () => {
  const ctx = makeCtx();
  insertEvent(ctx, "e1", "test", "dead_letter", 1000);
  insertEvent(ctx, "e2", "test", "dead_letter", 2000);
  insertEvent(ctx, "e3", "test", "pending",     3000); // should NOT change

  const req = new Request("http://x/v1/dead_letters/ack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_ids: ["e1", "e2", "e3"] }),
  });
  const res = await deadLettersAckHandler(req, ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.acknowledged).toBe(2);

  const rows = ctx.db.raw.query<{ event_id: string; status: string }, []>(
    "SELECT event_id, status FROM webhook_queue ORDER BY event_id",
  ).all() as Array<{ event_id: string; status: string }>;
  const map: Record<string, string> = {};
  for (const r of rows) map[r.event_id] = r.status;
  expect(map.e1).toBe("delivered");
  expect(map.e2).toBe("delivered");
  expect(map.e3).toBe("pending");
});

test("dead_letters_ack returns 400 invalid_request when event_ids missing", async () => {
  const ctx = makeCtx();
  const req = new Request("http://x/v1/dead_letters/ack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const res = await deadLettersAckHandler(req, ctx, {});
  expect(res.status).toBe(400);
  const body = await res.json() as any;
  expect(body.error).toBe("invalid_request");
});

test("dead_letters_list scopes a regular adapter to its own rows (ignores query param)", async () => {
  const ctx = makeCtx({ adapter_id: "test" });
  insertEvent(ctx, "e1", "test",  "dead_letter", 1000);
  insertEvent(ctx, "e2", "other", "dead_letter", 2000);

  // Caller asks for 'other' but only sees its own ('test').
  const req = new Request("http://x/v1/dead_letters?adapter_id=other", { method: "GET" });
  const res = await deadLettersListHandler(req, ctx, {});
  const body = await res.json() as any;
  expect(body.dead_letters.map((r: any) => r.event_id)).toEqual(["e1"]);
});

test("dead_letters_ack only acks the caller's own rows when not admin", async () => {
  const ctx = makeCtx({ adapter_id: "test" });
  insertEvent(ctx, "e1", "test",  "dead_letter", 1000);
  insertEvent(ctx, "e2", "other", "dead_letter", 2000); // foreign — must NOT be acked

  const req = new Request("http://x/v1/dead_letters/ack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_ids: ["e1", "e2"] }),
  });
  const res = await deadLettersAckHandler(req, ctx, {});
  const body = await res.json() as any;
  expect(body.acknowledged).toBe(1); // only e1

  const map: Record<string, string> = {};
  for (const r of ctx.db.raw.query<{ event_id: string; status: string }, []>(
    "SELECT event_id, status FROM webhook_queue",
  ).all() as Array<{ event_id: string; status: string }>) map[r.event_id] = r.status;
  expect(map.e1).toBe("delivered");
  expect(map.e2).toBe("dead_letter");
});
