import { test, expect, beforeEach } from "bun:test";
import { recycleSessionHandler } from "./recycle-session";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeTmux } from "../../tmux/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";
import { mkdirSync, rmSync } from "fs";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-recycle";

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

test("recycle_session returns 404 for unknown session", async () => {
  const ctx = makeCtx();
  const req = new Request("http://x/v1/recycle_session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "00000000-0000-4000-8000-000000000000" }),
  });
  const res = await recycleSessionHandler(req, ctx, {});
  expect(res.status).toBe(404);
  const body = await res.json() as any;
  expect(body.error).toBe("session_not_live");
});

test("recycle_session swaps live row to closed and inserts new live row", async () => {
  const ctx = makeCtx();
  const oldId = "00000000-0000-4000-8000-00000000bbbb";
  const tmuxName = "para-raid-rcy-h";
  // Pre-register tmux session in fake; recycler closes then relaunches.
  (ctx.tmux as any).sessions.add(tmuxName);
  mkdirSync(`${TMP}/wd`, { recursive: true });
  ctx.db.raw.run(
    "INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [oldId, "test", "ref-rcy", "live", tmuxName, `${TMP}/wd`, "", "http://localhost/webhook", Date.now(), Date.now()]
  );

  const req = new Request("http://x/v1/recycle_session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: oldId }),
  });
  // Drive SessionEnd (closer) then SessionStart for whatever new id launchSession picks.
  setTimeout(() => ctx.bus.emit({ hook_event_name: "SessionEnd", session_id: oldId, cwd: "/tmp" } as any), 20);
  const tHandle = setInterval(() => {
    const launchCalls = (ctx.tmux as any).calls.filter((c: any) => c.method === "newSession");
    if (launchCalls.length === 0) return;
    clearInterval(tHandle);
    const cmd = launchCalls[0].args[2] as string;
    const m = cmd.match(/--session-id\s+([a-f0-9-]{36})/i);
    if (m) ctx.bus.emit({ hook_event_name: "SessionStart", session_id: m[1], cwd: "/tmp" } as any);
  }, 20);

  const res = await recycleSessionHandler(req, ctx, {});
  expect(res.status).toBe(202);
  const body = await res.json() as any;
  expect(body.old_session_id).toBe(oldId);
  expect(body.new_session_id).toMatch(/^[0-9a-f-]{36}$/i);
  expect(body.new_session_id).not.toBe(oldId);

  const oldRow = ctx.db.raw.query<any, [string]>("SELECT status FROM sessions WHERE id = ?").get(oldId);
  expect(oldRow.status).toBe("closed");
  const newRow = ctx.db.raw.query<any, [string]>("SELECT status FROM sessions WHERE id = ?").get(body.new_session_id);
  expect(newRow.status).toBe("live");
  const ev = ctx.db.raw.query<{ event_type: string }, []>("SELECT event_type FROM webhook_queue").all();
  expect(ev.map(e => e.event_type)).toContain("session_recycled");
});

test("recycle_session returns 403 when a different adapter owns the session", async () => {
  const ctx = makeCtx({ adapter_id: "intruder" });
  const oldId = "00000000-0000-4000-8000-00000000bbbc";
  const tmuxName = "para-raid-rcy-acl";
  (ctx.tmux as any).sessions.add(tmuxName);
  mkdirSync(`${TMP}/wd`, { recursive: true });
  ctx.db.raw.run(
    "INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [oldId, "test", "ref-rcy", "live", tmuxName, `${TMP}/wd`, "", "http://localhost/webhook", Date.now(), Date.now()]
  );
  const req = new Request("http://x/v1/recycle_session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: oldId }),
  });
  expect(recycleSessionHandler(req, ctx, {})).rejects.toThrow(/own this session/);
});
