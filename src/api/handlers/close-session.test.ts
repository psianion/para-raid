import { test, expect, beforeEach } from "bun:test";
import { closeSessionHandler } from "./close-session";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeTmux } from "../../tmux/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";
import { mkdirSync, rmSync } from "fs";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-close";

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
  return { db, bus, tmux, modeController, dispatcher, config, logger: NOOP_LOGGER, hookEventsPath: (config.daemon as any).hook_events_path, adapter_id: "test", ...overrides };
}

test("close_session returns 200 closing for a live session", async () => {
  const ctx = makeCtx();
  const sessionId = "00000000-0000-4000-8000-00000000aaaa";
  const tmuxName = "para-raid-test-close";
  // Pre-register tmux session in fake so closer's hasSession sees it
  (ctx.tmux as any).sessions.add(tmuxName);
  ctx.db.raw.run(
    "INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [sessionId, "test", "ref-close", "live", tmuxName, `${TMP}/wd`, "", "http://localhost/webhook", Date.now(), Date.now()]
  );
  mkdirSync(`${TMP}/wd`, { recursive: true });

  const req = new Request("http://x/v1/close_session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  });
  // Drive the SessionEnd event so the closer's await resolves.
  setTimeout(() => ctx.bus.emit({ hook_event_name: "SessionEnd", session_id: sessionId, cwd: "/tmp" } as any), 20);

  const res = await closeSessionHandler(req, ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.status).toBe("closing");
  expect(body.session_id).toBe(sessionId);
});

test("close_session returns 404 for unknown session", async () => {
  const ctx = makeCtx();
  const req = new Request("http://x/v1/close_session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000000" }),
  });
  const res = await closeSessionHandler(req, ctx, {});
  expect(res.status).toBe(404);
  const body = await res.json() as any;
  expect(body.error).toBe("not_found");
});

test("close_session returns 403 when a different adapter owns the session", async () => {
  const ctx = makeCtx({ adapter_id: "intruder" });
  const sessionId = "00000000-0000-4000-8000-00000000acdc";
  const tmuxName = "para-raid-test-close-acl";
  (ctx.tmux as any).sessions.add(tmuxName);
  ctx.db.raw.run(
    "INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [sessionId, "test", "ref-close", "live", tmuxName, `${TMP}/wd`, "", "http://localhost/webhook", Date.now(), Date.now()]
  );
  mkdirSync(`${TMP}/wd`, { recursive: true });
  const req = new Request("http://x/v1/close_session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId }),
  });
  expect(closeSessionHandler(req, ctx, {})).rejects.toThrow(/own this session/);
});
