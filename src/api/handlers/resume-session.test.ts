import { test, expect, beforeEach, afterEach } from "bun:test";
import { launchDefaults } from "../../sessions/launcher";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { resumeSessionHandler, __resumeHooks } from "./resume-session";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeRuntime, type FakeRuntime } from "../../worker/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
launchDefaults.readyGraceMs = 30; // fake workers: no early-exit watch needed
const TMP = "/tmp/pararaid-w56-resume";

const ORIG_BACKOFF = __resumeHooks.backoffMs;
const ORIG_LAUNCH = __resumeHooks.launchGraceMs;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  __resumeHooks.backoffMs = 1;          // keep tests fast
  __resumeHooks.launchGraceMs = 100;  // every relaunch that dies is caught inside the grace window
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  __resumeHooks.backoffMs = ORIG_BACKOFF;
  __resumeHooks.launchGraceMs = ORIG_LAUNCH;
});

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

function insertRecoveringSession(ctx: HandlerCtx, id: string): string {
  const now = Date.now();
  const cwd = `${TMP}/cwd-${id}`;
  mkdirSync(cwd, { recursive: true });
  ctx.db.raw.run(
    `INSERT INTO sessions (id, adapter_id, adapter_ref, status, cwd, mcp_bundle, webhook_url, created_at, updated_at, recovery_expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, "test", `ref-${id}`, "recovering", cwd, "", "http://x/hook", now, now, now + 600_000],
  );
  return cwd;
}

const post = (body: unknown) => new Request("http://x/v1/resume_session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test("resume_session relaunches the worker with --resume, flips to 'live' and emits session_resumed", async () => {
  const ctx = makeCtx();
  const sid = "55555555-5555-4555-8555-555555555555";
  const cwd = insertRecoveringSession(ctx, sid);
  writeFileSync(`${cwd}/.mcp.json`, "{}");


  const res = await resumeSessionHandler(post({ session_id: sid }), ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.status).toBe("live");
  expect(ctx.runtime.spawns).toEqual([{ sessionId: sid, cwd, mode: "resume", mcpConfigPath: join(cwd, ".mcp.json") }]); // first attempt succeeded; no retries

  const row = ctx.db.raw.query<{ status: string; recovery_expires_at: number | null }, [string]>(
    "SELECT status, recovery_expires_at FROM sessions WHERE id = ?",
  ).get(sid)!;
  expect(row.status).toBe("live");
  expect(row.recovery_expires_at).toBeNull();

  const wh = ctx.db.raw.query<{ event_type: string }, [string]>(
    "SELECT event_type FROM webhook_queue WHERE session_id = ? AND event_type = 'session_resumed' LIMIT 1",
  ).get(sid);
  expect(wh).not.toBeNull();
});

test("resume_session flips to 'dead' and emits session_dead after 3 failed launches", async () => {
  const ctx = makeCtx();
  const sid = "66666666-6666-4666-8666-666666666666";
  insertRecoveringSession(ctx, sid);
  ctx.runtime.exitOnSpawn = 1; // every relaunch dies immediately

  const res = await resumeSessionHandler(post({ session_id: sid }), ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.status).toBe("dead");
  expect(body.error).toMatch(/attempt 3/);
  expect(ctx.runtime.spawns).toHaveLength(3);

  const row = ctx.db.raw.query<{ status: string }, [string]>("SELECT status FROM sessions WHERE id = ?").get(sid)!;
  expect(row.status).toBe("dead");

  const wh = ctx.db.raw.query<{ payload_json: string }, [string]>(
    "SELECT payload_json FROM webhook_queue WHERE session_id = ? AND event_type = 'session_dead' LIMIT 1",
  ).get(sid)!;
  expect(JSON.parse(wh.payload_json).reason).toBe("resume_failed");
});

test("resume_session returns 404 session_not_recovering for non-recovering sessions", async () => {
  const ctx = makeCtx();
  const sid = "77777777-7777-4777-8777-777777777777";
  ctx.db.raw.run(
    `INSERT INTO sessions (id, adapter_id, adapter_ref, status, cwd, mcp_bundle, webhook_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [sid, "test", "ref-live", "live", `${TMP}/live`, "", "http://x/hook", Date.now(), Date.now()],
  );
  const res = await resumeSessionHandler(post({ session_id: sid }), ctx, {});
  expect(res.status).toBe(404);
  expect((await res.json() as any).error).toBe("session_not_recovering");
});

test("resume_session returns 403 when a different adapter owns the session", async () => {
  const ctx = makeCtx({ adapter_id: "intruder" });
  const sid = "55555555-5555-4555-8555-555555555556";
  insertRecoveringSession(ctx, sid); // seeded with adapter_id 'test'
  expect(resumeSessionHandler(post({ session_id: sid }), ctx, {})).rejects.toThrow(/own this session/);
});

test("resume_session acks a second concurrent request without a second launch", async () => {
  const ctx = makeCtx();
  const sid = "88888888-8888-4888-8888-888888888888";
  insertRecoveringSession(ctx, sid);

  const first = resumeSessionHandler(post({ session_id: sid }), ctx, {});
  await new Promise((r) => setTimeout(r, 10)); // first request has claimed the resume and spawned
  const second = await resumeSessionHandler(post({ session_id: sid }), ctx, {});
  expect((await second.json() as any).status).toBe("recovering");

  expect((await (await first).json() as any).status).toBe("live");
  expect(ctx.runtime.spawns).toHaveLength(1);
});
