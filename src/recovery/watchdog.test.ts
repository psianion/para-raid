import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { createDb } from "../db";
import { createEventBus } from "../events/bus";
import { createFakeRuntime, type FakeRuntime } from "../worker/fake";
import type { Logger } from "../logger";
import { watchdogTick, type WatchdogCtx } from "./watchdog";

const NOOP_LOGGER: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const TMP = "/tmp/pararaid-w62-watchdog";

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

function makeCtx(): WatchdogCtx & { runtime: FakeRuntime } {
  const db = createDb(":memory:");
  const runtime = createFakeRuntime(createEventBus());
  return { db, runtime, logger: NOOP_LOGGER };
}

function insertLiveSession(ctx: WatchdogCtx, id: string, cwd: string): void {
  const now = Date.now();
  ctx.db.raw.run(
    `INSERT INTO sessions
       (id, adapter_id, adapter_ref, cwd, mcp_bundle, webhook_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, "test-adapter", `ref-${id}`, cwd, "{}", "http://localhost/webhook", "live", now, now]
  );
}

function insertTurn(ctx: WatchdogCtx, sessionId: string, dispatchedAt: number): void {
  ctx.db.raw.run(
    `INSERT INTO turns (id, session_id, status, prompt_sha256, created_at, dispatched_at, completed_at)
     VALUES (?, ?, 'dispatching', 'sha', ?, ?, NULL)`,
    [`turn-${sessionId}`, sessionId, dispatchedAt, dispatchedAt]
  );
}

test("watchdog: reaps a live session with a turn stuck dispatching past threshold, and kills its worker", async () => {
  const ctx = makeCtx();
  const sessionId = "00000000-0000-4000-8000-00000000dddd";
  const workdir = `${TMP}/wd-stuck`;
  mkdirSync(workdir, { recursive: true });

  ctx.runtime.spawn({ sessionId, cwd: workdir, mode: "new" }); // tier-0 passes
  insertLiveSession(ctx, sessionId, workdir);
  insertTurn(ctx, sessionId, Date.now() - 11 * 60_000); // dispatching 11 min ago

  await watchdogTick(ctx);

  const row = ctx.db.raw
    .query<{ status: string }, [string]>("SELECT status FROM sessions WHERE id = ?")
    .get(sessionId);
  expect(row?.status).toBe("dead");

  const events = ctx.db.raw
    .query<{ event_type: string; payload_json: string }, []>(
      "SELECT event_type, payload_json FROM webhook_queue"
    )
    .all();
  expect(events).toHaveLength(1);
  expect(events[0]!.event_type).toBe("session_dead");
  expect(JSON.parse(events[0]!.payload_json).reason).toBe("stuck_turn");

  expect(existsSync(workdir)).toBe(false);
  expect(ctx.runtime.workers.get(sessionId)!.killed).toContain("SIGTERM");
});

test("watchdog: leaves a live session with a recently-dispatched turn alone", async () => {
  const ctx = makeCtx();
  const sessionId = "00000000-0000-4000-8000-00000000eeee";
  const workdir = `${TMP}/wd-fresh`;
  mkdirSync(workdir, { recursive: true });

  ctx.runtime.spawn({ sessionId, cwd: workdir, mode: "new" });
  insertLiveSession(ctx, sessionId, workdir);
  insertTurn(ctx, sessionId, Date.now() - 2 * 60_000); // dispatching 2 min ago

  await watchdogTick(ctx);

  const row = ctx.db.raw
    .query<{ status: string }, [string]>("SELECT status FROM sessions WHERE id = ?")
    .get(sessionId);
  expect(row?.status).toBe("live");
  expect(ctx.db.raw.query<{ event_type: string }, []>("SELECT event_type FROM webhook_queue").all()).toHaveLength(0);
  expect(existsSync(workdir)).toBe(true);
});

test("watchdog: marks a live session dead when its worker process is gone", async () => {
  const ctx = makeCtx();
  const sessionId = "00000000-0000-4000-8000-00000000aaaa";
  const workdir = `${TMP}/wd-gone`;
  mkdirSync(workdir, { recursive: true });

  // No worker spawned for this session.
  insertLiveSession(ctx, sessionId, workdir);

  await watchdogTick(ctx);

  const row = ctx.db.raw
    .query<{ status: string }, [string]>("SELECT status FROM sessions WHERE id = ?")
    .get(sessionId);
  expect(row?.status).toBe("dead");

  const events = ctx.db.raw
    .query<{ event_type: string; payload_json: string; status: string; webhook_url: string }, []>(
      "SELECT event_type, payload_json, status, webhook_url FROM webhook_queue"
    )
    .all();
  expect(events).toHaveLength(1);
  expect(events[0]!.event_type).toBe("session_dead");
  expect(events[0]!.status).toBe("pending");
  expect(events[0]!.webhook_url).toBe("http://localhost/webhook");
  const payload = JSON.parse(events[0]!.payload_json);
  expect(payload.reason).toBe("external_kill");
  expect(payload.session_id).toBe(sessionId);
  expect(existsSync(workdir)).toBe(false);
});

test("watchdog: marks a live session dead when its worker has exited", async () => {
  const ctx = makeCtx();
  const sessionId = "00000000-0000-4000-8000-00000000cccc";
  const workdir = `${TMP}/wd-exited`;
  mkdirSync(workdir, { recursive: true });

  ctx.runtime.spawn({ sessionId, cwd: workdir, mode: "new" });
  ctx.runtime.emitExit(sessionId, 137); // OOM-killed
  insertLiveSession(ctx, sessionId, workdir);

  await watchdogTick(ctx);

  const row = ctx.db.raw
    .query<{ status: string }, [string]>("SELECT status FROM sessions WHERE id = ?")
    .get(sessionId);
  expect(row?.status).toBe("dead");
  const events = ctx.db.raw
    .query<{ payload_json: string }, []>("SELECT payload_json FROM webhook_queue")
    .all();
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]!.payload_json).reason).toBe("external_kill");
});

test("watchdog: leaves a healthy live session alone", async () => {
  const ctx = makeCtx();
  const sessionId = "00000000-0000-4000-8000-00000000bbbb";
  const workdir = `${TMP}/wd-healthy`;
  mkdirSync(workdir, { recursive: true });

  ctx.runtime.spawn({ sessionId, cwd: workdir, mode: "new" });
  insertLiveSession(ctx, sessionId, workdir);

  await watchdogTick(ctx);

  const row = ctx.db.raw
    .query<{ status: string }, [string]>("SELECT status FROM sessions WHERE id = ?")
    .get(sessionId);
  expect(row?.status).toBe("live");
  expect(ctx.db.raw.query<{ event_type: string }, []>("SELECT event_type FROM webhook_queue").all()).toHaveLength(0);
  expect(existsSync(workdir)).toBe(true);
});
