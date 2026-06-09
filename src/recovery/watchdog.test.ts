import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { createDb } from "../db";
import { createFakeTmux } from "../tmux/fake";
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

function makeCtx(): WatchdogCtx & { tmux: ReturnType<typeof createFakeTmux> } {
  const db = createDb(":memory:");
  const tmux = createFakeTmux();
  return { db, tmux, logger: NOOP_LOGGER };
}

function insertLiveSession(
  ctx: WatchdogCtx,
  id: string,
  tmuxName: string,
  cwd: string
): void {
  const now = Date.now();
  ctx.db.raw.run(
    `INSERT INTO sessions
       (id, adapter_id, adapter_ref, tmux_session, cwd, mcp_bundle, webhook_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      "test-adapter",
      `ref-${id}`,
      tmuxName,
      cwd,
      "{}",
      "http://localhost/webhook",
      "live",
      now,
      now,
    ]
  );
}

test("watchdog: marks live session as dead when tmux is gone", async () => {
  const ctx = makeCtx();
  const sessionId = "00000000-0000-4000-8000-00000000aaaa";
  const tmuxName = "para-raid-watchdog-gone";
  const workdir = `${TMP}/wd-gone`;
  mkdirSync(workdir, { recursive: true });

  // tmux is empty — session_id not registered with the fake.
  insertLiveSession(ctx, sessionId, tmuxName, workdir);

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

  // workdir cleaned up
  expect(existsSync(workdir)).toBe(false);
});

test("watchdog: leaves healthy live session alone", async () => {
  const ctx = makeCtx();
  const sessionId = "00000000-0000-4000-8000-00000000bbbb";
  const tmuxName = "para-raid-watchdog-healthy";
  const workdir = `${TMP}/wd-healthy`;
  mkdirSync(workdir, { recursive: true });

  // Register tmux session in the fake — hasSession=true and listPanePid returns 12345.
  ctx.tmux.sessions.add(tmuxName);
  insertLiveSession(ctx, sessionId, tmuxName, workdir);

  await watchdogTick(ctx);

  const row = ctx.db.raw
    .query<{ status: string }, [string]>("SELECT status FROM sessions WHERE id = ?")
    .get(sessionId);
  expect(row?.status).toBe("live");

  const events = ctx.db.raw
    .query<{ event_type: string }, []>("SELECT event_type FROM webhook_queue")
    .all();
  expect(events).toHaveLength(0);

  // workdir still present
  expect(existsSync(workdir)).toBe(true);
});

test("watchdog: marks live session as dead when listPanePid returns null", async () => {
  const ctx = makeCtx();
  const sessionId = "00000000-0000-4000-8000-00000000cccc";
  const tmuxName = "para-raid-watchdog-nopid";
  const workdir = `${TMP}/wd-nopid`;
  mkdirSync(workdir, { recursive: true });

  // tmux session exists (hasSession=true) but pane PID lookup returns null.
  ctx.tmux.sessions.add(tmuxName);
  ctx.tmux.listPanePid = async () => null;

  insertLiveSession(ctx, sessionId, tmuxName, workdir);

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
  expect(JSON.parse(events[0]!.payload_json).reason).toBe("external_kill");
});
