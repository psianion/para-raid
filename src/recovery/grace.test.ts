import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { startGraceTimer } from "./grace";
import type { BootCtx } from "./boot";
import { createDb } from "../db";
import { createEventBus } from "../events/bus";
import { createFakeTmux } from "../tmux/fake";
import type { ParaRaidConfig } from "../types";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w6-grace";

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function makeCtx(): BootCtx {
  const db = createDb(":memory:");
  const bus = createEventBus();
  const tmux = createFakeTmux();
  const config = {
    daemon: { data_dir: TMP, socket_path: "/tmp/x.sock" },
    concurrency: { max_concurrent_turns: 3, max_total_sessions: 10 },
    recovery: { grace_window_ms: 600_000 },
    publisher: { retry_window_ms: 600_000, backoff_ms: [1000] },
    limit: { warning_regex: "approaching" },
    auth: "none",
    signing: "none",
    adapters: { test: { webhook_url: "http://x/hook" } },
  } as unknown as ParaRaidConfig;
  return { db, bus, tmux, config, logger: NOOP_LOGGER };
}

function insertRecoveringSession(
  ctx: BootCtx,
  id: string,
  cwd: string,
  expiresAt: number,
): void {
  const now = Date.now();
  ctx.db.raw.run(
    `INSERT INTO sessions
     (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at, recovery_expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      "test",
      `ref-${id}`,
      "recovering",
      `tmx-${id}`,
      cwd,
      "",
      "http://x/hook",
      now,
      now,
      expiresAt,
    ],
  );
}

// Helper: run one tick by starting the timer with a tiny interval and waiting.
async function singleTick(ctx: BootCtx): Promise<void> {
  const handle = startGraceTimer(ctx, 5);
  // Give the interval one fire window plus a margin.
  await new Promise((r) => setTimeout(r, 30));
  handle.stop();
}

test("grace: flips expired recovering rows to dead, cleans workdir, enqueues session_dead", async () => {
  const ctx = makeCtx();
  const sessionId = "00000000-0000-4000-8000-00000000c001";
  const cwd = `${TMP}/wd-expired`;
  mkdirSync(cwd, { recursive: true });

  // Expired 60s ago.
  insertRecoveringSession(ctx, sessionId, cwd, Date.now() - 60_000);

  await singleTick(ctx);

  const row = ctx.db.raw
    .query<{ status: string }, [string]>(
      `SELECT status FROM sessions WHERE id = ?`,
    )
    .get(sessionId);
  expect(row?.status).toBe("dead");

  const enq = ctx.db.raw
    .query<{ event_type: string; payload_json: string; status: string }, [string]>(
      `SELECT event_type, payload_json, status FROM webhook_queue WHERE session_id = ?`,
    )
    .all(sessionId);
  expect(enq.length).toBe(1);
  expect(enq[0].event_type).toBe("session_dead");
  expect(enq[0].status).toBe("pending");
  const payload = JSON.parse(enq[0].payload_json);
  expect(payload.reason).toBe("grace_expired");
  expect(payload.session_id).toBe(sessionId);

  expect(existsSync(cwd)).toBe(false);
});

test("grace: leaves non-expired recovering rows alone", async () => {
  const ctx = makeCtx();
  const sessionId = "00000000-0000-4000-8000-00000000c002";
  const cwd = `${TMP}/wd-fresh`;
  mkdirSync(cwd, { recursive: true });

  // Expires 10 minutes from now.
  insertRecoveringSession(ctx, sessionId, cwd, Date.now() + 600_000);

  await singleTick(ctx);

  const row = ctx.db.raw
    .query<{ status: string }, [string]>(
      `SELECT status FROM sessions WHERE id = ?`,
    )
    .get(sessionId);
  expect(row?.status).toBe("recovering");

  const enq = ctx.db.raw
    .query<{ event_type: string }, [string]>(
      `SELECT event_type FROM webhook_queue WHERE session_id = ?`,
    )
    .all(sessionId);
  expect(enq.length).toBe(0);

  expect(existsSync(cwd)).toBe(true);
});
