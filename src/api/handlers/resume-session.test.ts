import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { resumeSessionHandler, __resumeHooks } from "./resume-session";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeTmux } from "../../tmux/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-resume";

const ORIG_SPAWN = __resumeHooks.spawn;
const ORIG_BACKOFF = __resumeHooks.backoffMs;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  __resumeHooks.backoffMs = 1; // keep tests fast
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  __resumeHooks.spawn = ORIG_SPAWN;
  __resumeHooks.backoffMs = ORIG_BACKOFF;
});

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
    ...overrides,
  };
}

function insertRecoveringSession(ctx: HandlerCtx, id: string): void {
  const now = Date.now();
  ctx.db.raw.run(
    `INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at, recovery_expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, "test", `ref-${id}`, "recovering", `tmx-${id}`, `${TMP}/cwd-${id}`, "", "http://x/hook", now, now, now + 600_000],
  );
}

test("resume_session flips to 'live' and emits session_resumed when claude --resume exits 0", async () => {
  const ctx = makeCtx();
  const sid = "55555555-5555-4555-8555-555555555555";
  insertRecoveringSession(ctx, sid);

  let calls = 0;
  __resumeHooks.spawn = async () => { calls++; return true; };

  const req = new Request("http://x/v1/resume_session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Adapter-Id": "test" },
    body: JSON.stringify({ session_id: sid }),
  });
  const res = await resumeSessionHandler(req, ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.status).toBe("live");
  expect(calls).toBe(1); // first attempt succeeded; no retries

  const row = ctx.db.raw.query<{ status: string }, [string]>(
    "SELECT status FROM sessions WHERE id = ?",
  ).get(sid) as { status: string };
  expect(row.status).toBe("live");

  const wh = ctx.db.raw.query<{ event_type: string }, [string]>(
    "SELECT event_type FROM webhook_queue WHERE session_id = ? AND event_type = 'session_resumed' LIMIT 1",
  ).get(sid) as { event_type: string } | null;
  expect(wh).not.toBeNull();
});

test("resume_session flips to 'dead' and emits session_dead after 3 spawn failures", async () => {
  const ctx = makeCtx();
  const sid = "66666666-6666-4666-8666-666666666666";
  insertRecoveringSession(ctx, sid);

  let calls = 0;
  __resumeHooks.spawn = async () => { calls++; return false; };

  const req = new Request("http://x/v1/resume_session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Adapter-Id": "test" },
    body: JSON.stringify({ session_id: sid }),
  });
  const res = await resumeSessionHandler(req, ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.status).toBe("dead");
  expect(calls).toBe(3);

  const row = ctx.db.raw.query<{ status: string }, [string]>(
    "SELECT status FROM sessions WHERE id = ?",
  ).get(sid) as { status: string };
  expect(row.status).toBe("dead");

  const wh = ctx.db.raw.query<{ event_type: string; payload_json: string }, [string]>(
    "SELECT event_type, payload_json FROM webhook_queue WHERE session_id = ? AND event_type = 'session_dead' LIMIT 1",
  ).get(sid) as { event_type: string; payload_json: string } | null;
  expect(wh).not.toBeNull();
  const payload = JSON.parse(wh!.payload_json);
  expect(payload.reason).toBe("resume_failed");
});

test("resume_session returns 404 session_not_recovering for non-recovering sessions", async () => {
  const ctx = makeCtx();
  // live session — not in the recovering state
  const sid = "77777777-7777-4777-8777-777777777777";
  ctx.db.raw.run(
    `INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [sid, "test", "ref-live", "live", "tmx-live", `${TMP}/live`, "", "http://x/hook", Date.now(), Date.now()],
  );

  const req = new Request("http://x/v1/resume_session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Adapter-Id": "test" },
    body: JSON.stringify({ session_id: sid }),
  });
  const res = await resumeSessionHandler(req, ctx, {});
  expect(res.status).toBe(404);
  const body = await res.json() as any;
  expect(body.error).toBe("session_not_recovering");
});
