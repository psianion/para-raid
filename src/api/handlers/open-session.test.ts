import { test, expect, beforeEach } from "bun:test";
import { openSessionHandler } from "./open-session";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeTmux } from "../../tmux/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-open";

beforeEach(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });

function makeCtx(overrides: Partial<HandlerCtx> = {}): HandlerCtx {
  const db = createDb(":memory:");
  const bus = createEventBus();
  const tmux = createFakeTmux();
  const modeController = createModeController();
  const dispatcher = createDispatcher({
    maxConcurrentTurns: 3, tmux,
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
  return { db, bus, tmux, modeController, dispatcher, config, logger: NOOP_LOGGER, hookEventsPath: (config.daemon as any).hook_events_path, ...overrides };
}

test("open_session rejects a blocked webhook_url with 400", async () => {
  const ctx = makeCtx();
  const req = new Request("http://x/v1/open_session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Adapter-Id": "test" },
    body: JSON.stringify({ adapter_id: "test", adapter_ref: "ref-ssrf", prompt: "hi", webhook_url: "http://169.254.169.254/latest/meta-data/" }),
  });
  const res = await openSessionHandler(req, ctx, {});
  expect(res.status).toBe(400);
});

test("open_session inserts rows and returns 202", async () => {
  const ctx = makeCtx();
  const req = new Request("http://x/v1/open_session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Adapter-Id": "test" },
    body: JSON.stringify({ adapter_id: "test", adapter_ref: "ref-1", prompt: "say hi", webhook_url: "http://x/hook" }),
  });
  const res = await openSessionHandler(req, ctx, {});
  expect(res.status).toBe(202);
  const body = await res.json() as any;
  expect(body.session_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(body.turn_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(body.status).toBe("launching");
  const sess = ctx.db.raw.query<any, [string]>("SELECT id, status FROM sessions WHERE id = ?").get(body.session_id);
  expect(sess.status).toBe("launching");
  const events = ctx.db.raw.query<{ event_type: string }, []>("SELECT event_type FROM webhook_queue").all();
  expect(events.map(e => e.event_type)).toContain("session_open_acknowledged");
});

test("open_session renders .mcp.json for the requested bundle", async () => {
  const ctx = makeCtx({
    bundles: [{ name: "scrypt", servers: [{ type: "http", name: "scrypt", url: "http://127.0.0.1:3777/mcp" }] }],
  } as Partial<HandlerCtx>);
  const req = new Request("http://x/v1/open_session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Adapter-Id": "test" },
    body: JSON.stringify({ adapter_id: "test", adapter_ref: "ref-mcp", prompt: "hi", webhook_url: "http://x/h", bundle_name: "scrypt" }),
  });
  const res = await openSessionHandler(req, ctx, {});
  expect(res.status).toBe(202);
  const body = await res.json() as any;
  const sess = ctx.db.raw.query<{ cwd: string }, [string]>("SELECT cwd FROM sessions WHERE id = ?").get(body.session_id)!;
  const mcpPath = join(sess.cwd, ".mcp.json");
  expect(existsSync(mcpPath)).toBe(true);
  expect(JSON.parse(readFileSync(mcpPath, "utf-8")).mcpServers.scrypt.url).toBe("http://127.0.0.1:3777/mcp");
});

test("open_session returns 400 for an unknown bundle", async () => {
  const ctx = makeCtx({ bundles: [] } as Partial<HandlerCtx>);
  const req = new Request("http://x/v1/open_session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Adapter-Id": "test" },
    body: JSON.stringify({ adapter_id: "test", adapter_ref: "ref-x", prompt: "hi", webhook_url: "http://x/h", bundle_name: "nope" }),
  });
  const res = await openSessionHandler(req, ctx, {});
  expect(res.status).toBe(400);
  expect((await res.json() as any).error).toBe("unknown_bundle");
});

test("open_session returns 503 paused when mode is paused", async () => {
  const ctx = makeCtx();
  ctx.modeController.pause();
  const req = new Request("http://x/v1/open_session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Adapter-Id": "test" },
    body: JSON.stringify({ adapter_id: "test", adapter_ref: "ref-1", prompt: "x", webhook_url: "http://x/h" }),
  });
  const res = await openSessionHandler(req, ctx, {});
  expect(res.status).toBe(503);
  const body = await res.json() as any;
  expect(body.error).toBe("paused");
});

test("open_session returns 429 pool_full at max_total_sessions", async () => {
  const ctx = makeCtx();
  for (let i = 0; i < 10; i++) {
    ctx.db.raw.run(
      "INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [`s${i}`, "test", `ref-${i}`, "live", `tmx${i}`, `/tmp/x${i}`, "", "http://localhost/webhook", Date.now(), Date.now()]
    );
  }
  const req = new Request("http://x/v1/open_session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Adapter-Id": "test" },
    body: JSON.stringify({ adapter_id: "test", adapter_ref: "ref-new", prompt: "x", webhook_url: "http://x/h" }),
  });
  const res = await openSessionHandler(req, ctx, {});
  expect(res.status).toBe(429);
});

test("open_session reclaims a recovering session for same adapter_ref", async () => {
  const ctx = makeCtx();
  ctx.db.raw.run(
    "INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at, recovery_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ["existing-id", "test", "ref-recov", "recovering", "tmx-recov", `${TMP}/recov`, "", "http://localhost/webhook", Date.now(), Date.now(), Date.now() + 600_000]
  );
  const req = new Request("http://x/v1/open_session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Adapter-Id": "test" },
    body: JSON.stringify({ adapter_id: "test", adapter_ref: "ref-recov", prompt: "x", webhook_url: "http://x/h" }),
  });
  const res = await openSessionHandler(req, ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.session_id).toBe("existing-id");
  expect(body.status).toBe("recovering");
});
