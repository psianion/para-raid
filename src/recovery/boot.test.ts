import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { reconcileOnBoot, type BootCtx } from "./boot";
import { createDb } from "../db";
import { createEventBus } from "../events/bus";
import { createFakeRuntime } from "../worker/fake";
import type { ParaRaidConfig } from "../types";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w6-boot";

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
  const runtime = createFakeRuntime(bus);
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
  return { db, bus, runtime, config, logger: NOOP_LOGGER };
}

function insertLiveSession(ctx: BootCtx, id: string, cwd: string): void {
  const now = Date.now();
  ctx.db.raw.run(
    `INSERT INTO sessions
     (id, adapter_id, adapter_ref, status, cwd, mcp_bundle, webhook_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, "test", `ref-${id}`, "live", cwd, "", "http://x/hook", now, now],
  );
}

test("boot: a live session whose workdir survived becomes recovering with a session_recover_candidate", async () => {
  const ctx = makeCtx();
  const sessionId = "00000000-0000-4000-8000-00000000b001";
  const cwd = `${TMP}/wd-alive`;
  mkdirSync(cwd, { recursive: true });
  insertLiveSession(ctx, sessionId, cwd);

  const result = await reconcileOnBoot(ctx);
  expect(result.recovering).toBe(1);
  expect(result.dead).toBe(0);

  const row = ctx.db.raw
    .query<{ status: string; recovery_expires_at: number | null }, [string]>(
      `SELECT status, recovery_expires_at FROM sessions WHERE id = ?`,
    )
    .get(sessionId);
  expect(row?.status).toBe("recovering");
  expect(row?.recovery_expires_at).not.toBeNull();
  expect(row!.recovery_expires_at!).toBeGreaterThan(Date.now() - 1000);

  const enq = ctx.db.raw
    .query<
      { event_type: string; payload_json: string; status: string; webhook_url: string },
      [string]
    >(
      `SELECT event_type, payload_json, status, webhook_url FROM webhook_queue WHERE session_id = ?`,
    )
    .all(sessionId);
  expect(enq.length).toBe(1);
  expect(enq[0].event_type).toBe("session_recover_candidate");
  expect(enq[0].status).toBe("pending");
  expect(enq[0].webhook_url).toBe("http://x/hook");
  const payload = JSON.parse(enq[0].payload_json);
  expect(payload.session_id).toBe(sessionId);
  expect(typeof payload.recovery_expires_at).toBe("number");

  // Workdir should NOT have been cleaned for a recovering session.
  expect(existsSync(cwd)).toBe(true);
});

test("boot: a live session whose workdir is gone becomes dead with session_dead", async () => {
  const ctx = makeCtx();
  const sessionId = "00000000-0000-4000-8000-00000000b002";
  const cwd = `${TMP}/wd-gone`; // never created
  insertLiveSession(ctx, sessionId, cwd);

  const result = await reconcileOnBoot(ctx);
  expect(result.dead).toBe(1);
  expect(result.recovering).toBe(0);

  const row = ctx.db.raw
    .query<{ status: string }, [string]>(`SELECT status FROM sessions WHERE id = ?`)
    .get(sessionId);
  expect(row?.status).toBe("dead");

  const enq = ctx.db.raw
    .query<{ event_type: string; payload_json: string }, [string]>(
      `SELECT event_type, payload_json FROM webhook_queue WHERE session_id = ?`,
    )
    .all(sessionId);
  expect(enq.length).toBe(1);
  expect(enq[0].event_type).toBe("session_dead");
  expect(JSON.parse(enq[0].payload_json).reason).toBe("workdir_gone_at_boot");
  expect(existsSync(cwd)).toBe(false);
});
