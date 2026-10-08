import { test, expect, beforeEach } from "bun:test";
import { launchDefaults } from "../../sessions/launcher";
import { openSessionHandler } from "./open-session";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeRuntime, type FakeRuntime } from "../../worker/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
launchDefaults.readyGraceMs = 30; // fake workers: no early-exit watch needed
const TMP = "/tmp/pararaid-w56-open";

beforeEach(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });

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
    adapters: { test: { webhook_url: "http://x/hook", token: "tkn-test" } },
  } as unknown as ParaRaidConfig;
  return { db, bus, runtime, modeController, dispatcher, config, logger: NOOP_LOGGER, adapter_id: "test", ...overrides } as HandlerCtx & { runtime: FakeRuntime };
}

const post = (body: unknown) => new Request("http://x/v1/open_session", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function waitFor(fn: () => boolean, ms = 2_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("waitFor timeout");
}

test("open_session inserts rows and returns 202", async () => {
  const ctx = makeCtx();
  const res = await openSessionHandler(post({ adapter_ref: "ref-1", prompt: "say hi" }), ctx, {});
  expect(res.status).toBe(202);
  const body = await res.json() as any;
  expect(body.session_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(body.turn_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(body.status).toBe("launching");
  const sess = ctx.db.raw.query<any, [string]>("SELECT id, status, cwd FROM sessions WHERE id = ?").get(body.session_id);
  expect(sess.status).toBe("launching");
  expect(sess.cwd).toBe(join(TMP, "workdirs", body.session_id));
  const events = ctx.db.raw.query<{ event_type: string }, []>("SELECT event_type FROM webhook_queue").all();
  expect(events.map(e => e.event_type)).toContain("session_open_acknowledged");
});

test("open_session spawns a worker in the workdir and goes live + replies once it reports ready", async () => {
  const ctx = makeCtx();
  const res = await openSessionHandler(post({ adapter_ref: "ref-live", prompt: "say hi" }), ctx, {});
  const body = await res.json() as any;
  await waitFor(() => ctx.runtime.spawns.length === 1);
  expect(ctx.runtime.spawns[0]).toEqual({ sessionId: body.session_id, cwd: join(TMP, "workdirs", body.session_id), mode: "new", mcpConfigPath: undefined });

  await waitFor(() => ctx.db.raw.query<{ status: string }, [string]>("SELECT status FROM turns WHERE id = ?").get(body.turn_id)?.status === "completed");
  const sess = ctx.db.raw.query<{ status: string }, [string]>("SELECT status FROM sessions WHERE id = ?").get(body.session_id);
  expect(sess?.status).toBe("live");
  const events = ctx.db.raw.query<{ event_type: string; payload_json: string }, []>("SELECT event_type, payload_json FROM webhook_queue ORDER BY id").all();
  expect(events.map(e => e.event_type)).toEqual(["session_open_acknowledged", "session_live", "turn_replied"]);
  expect(JSON.parse(events[2].payload_json).reply).toBe("stub-reply");
});

test("open_session marks the session dead and kills the worker when the launch fails", async () => {
  const ctx = makeCtx();
  ctx.runtime.exitOnSpawn = 1;
  const res = await openSessionHandler(post({ adapter_ref: "ref-fail", prompt: "say hi" }), ctx, {});
  const body = await res.json() as any;
  await waitFor(() => ctx.db.raw.query<{ status: string }, [string]>("SELECT status FROM sessions WHERE id = ?").get(body.session_id)?.status === "dead");
  const turn = ctx.db.raw.query<{ status: string; error: string }, [string]>("SELECT status, error FROM turns WHERE id = ?").get(body.turn_id)!;
  expect(turn.status).toBe("failed");
  expect(turn.error).toMatch(/exited before ready/);
  const dead = ctx.db.raw.query<{ payload_json: string }, []>("SELECT payload_json FROM webhook_queue WHERE event_type = 'session_dead'").get()!;
  expect(JSON.parse(dead.payload_json).reason).toBe("launch_failed");
});

test("open_session renders .mcp.json for the requested bundle and passes it to the worker", async () => {
  const ctx = makeCtx({
    bundles: [{ name: "scrypt", servers: [{ type: "http", name: "scrypt", url: "http://127.0.0.1:3777/mcp" }] }],
  } as Partial<HandlerCtx>);
  const res = await openSessionHandler(post({ adapter_ref: "ref-mcp", prompt: "hi", bundle_name: "scrypt" }), ctx, {});
  expect(res.status).toBe(202);
  const body = await res.json() as any;
  const sess = ctx.db.raw.query<{ cwd: string }, [string]>("SELECT cwd FROM sessions WHERE id = ?").get(body.session_id)!;
  const mcpPath = join(sess.cwd, ".mcp.json");
  expect(existsSync(mcpPath)).toBe(true);
  expect(JSON.parse(readFileSync(mcpPath, "utf-8")).mcpServers.scrypt.url).toBe("http://127.0.0.1:3777/mcp");
  await waitFor(() => ctx.runtime.spawns.length === 1);
  expect(ctx.runtime.spawns[0].mcpConfigPath).toBe(mcpPath);
});

test("open_session returns 400 for an unknown bundle", async () => {
  const ctx = makeCtx({ bundles: [] } as Partial<HandlerCtx>);
  const res = await openSessionHandler(post({ adapter_ref: "ref-x", prompt: "hi", bundle_name: "nope" }), ctx, {});
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toBe("unknown_bundle");
});

test("open_session returns 503 paused when mode is paused", async () => {
  const ctx = makeCtx();
  ctx.modeController.pause();
  const res = await openSessionHandler(post({ adapter_ref: "ref-1", prompt: "x" }), ctx, {});
  expect(res.status).toBe(503);
  expect((await res.json() as any).error).toBe("paused");
});

test("open_session returns 429 pool_full at max_total_sessions", async () => {
  const ctx = makeCtx();
  for (let i = 0; i < 10; i++) {
    ctx.db.raw.run(
      "INSERT INTO sessions (id, adapter_id, adapter_ref, status, cwd, mcp_bundle, webhook_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [`s${i}`, "test", `ref-${i}`, "live", `/tmp/x${i}`, "", "http://localhost/webhook", Date.now(), Date.now()]
    );
  }
  const res = await openSessionHandler(post({ adapter_ref: "ref-new", prompt: "x" }), ctx, {});
  expect(res.status).toBe(429);
});

test("open_session reclaims a recovering session for same adapter_ref", async () => {
  const ctx = makeCtx();
  ctx.db.raw.run(
    "INSERT INTO sessions (id, adapter_id, adapter_ref, status, cwd, mcp_bundle, webhook_url, created_at, updated_at, recovery_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ["existing-id", "test", "ref-recov", "recovering", `${TMP}/recov`, "", "http://localhost/webhook", Date.now(), Date.now(), Date.now() + 600_000]
  );
  const res = await openSessionHandler(post({ adapter_ref: "ref-recov", prompt: "x" }), ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.session_id).toBe("existing-id");
  expect(body.status).toBe("recovering");
});

test("open_session returns 403 for the admin identity (admin does not own sessions)", async () => {
  const ctx = makeCtx({ adapter_id: "__admin__" });
  const res = await openSessionHandler(post({ adapter_ref: "ref-admin", prompt: "hi" }), ctx, {});
  expect(res.status).toBe(403);
});

test("open_session uses the authenticated identity + config webhook_url, ignoring the body adapter_id", async () => {
  const ctx = makeCtx({ adapter_id: "test" });
  // body claims a different adapter_id and an SSRF webhook_url — both ignored.
  // The webhook target is the adapter's config value, so the body can't point
  // it at an internal address (SSRF-via-body is structurally impossible now).
  const res = await openSessionHandler(post({ adapter_id: "spoofed", adapter_ref: "ref-id", prompt: "hi", webhook_url: "http://169.254.169.254/latest/meta-data/" }), ctx, {});
  expect(res.status).toBe(202);
  const body = await res.json() as any;
  const sess = ctx.db.raw.query<{ adapter_id: string; webhook_url: string }, [string]>(
    "SELECT adapter_id, webhook_url FROM sessions WHERE id = ?",
  ).get(body.session_id)!;
  expect(sess.adapter_id).toBe("test");
  expect(sess.webhook_url).toBe("http://x/hook");
});
