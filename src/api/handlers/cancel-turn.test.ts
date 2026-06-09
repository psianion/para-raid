import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { cancelTurnHandler } from "./cancel-turn";
import { createDb } from "../../db";
import { createEventBus } from "../../events/bus";
import { createFakeTmux } from "../../tmux/fake";
import { createModeController } from "../../limit/mode-controller";
import { createDispatcher } from "../../sessions/dispatcher";
import type { HandlerCtx } from "../router";
import type { ParaRaidConfig } from "../../types";

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} } as any;
const TMP = "/tmp/pararaid-w56-cancel";

beforeEach(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

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

function insertLiveSession(ctx: HandlerCtx, id: string, tmuxName: string): void {
  const now = Date.now();
  ctx.db.raw.run(
    `INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, "test", `ref-${id}`, "live", tmuxName, `${TMP}/cwd-${id}`, "", "http://x/hook", now, now],
  );
  ctx.tmux.newSession(tmuxName, `${TMP}/cwd-${id}`, "true");
}

test("cancel_turn returns 200 with cancelled=true when Stop is observed", async () => {
  const ctx = makeCtx();
  const sid = "33333333-3333-4333-8333-333333333333";
  const tmuxName = "tmx-cancel-1";
  insertLiveSession(ctx, sid, tmuxName);

  const req = new Request("http://x/v1/cancel_turn", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Adapter-Id": "test" },
    body: JSON.stringify({ session_id: sid }),
  });

  // Emit Stop shortly after the handler subscribes. Because cancelTurn waits
  // up to escapeWaitMs (default 3000ms) for Stop, this must fire well before.
  setTimeout(() => {
    ctx.bus.emit({
      hook_event_name: "Stop",
      session_id: sid,
      transcript_path: `${TMP}/cwd-${sid}/transcript.jsonl`,
    } as any);
  }, 50);

  const res = await cancelTurnHandler(req, ctx, {});
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.cancelled).toBe(true);
  expect(body.escalated_to_ctrl_c).toBe(false);

  // Escape was sent; Ctrl-C was NOT.
  const calls = (ctx.tmux as any).calls as Array<{ method: string; args: unknown[] }>;
  expect(calls.some(c => c.method === "sendEscape" && c.args[0] === tmuxName)).toBe(true);
  expect(calls.some(c => c.method === "sendCtrlC" && c.args[0] === tmuxName)).toBe(false);

  // turn_cancelled webhook enqueued.
  const wh = ctx.db.raw.query<{ payload_json: string }, [string]>(
    "SELECT payload_json FROM webhook_queue WHERE session_id = ? AND event_type = 'turn_cancelled' LIMIT 1",
  ).get(sid) as { payload_json: string } | null;
  expect(wh).not.toBeNull();
  const payload = JSON.parse(wh!.payload_json);
  expect(payload.cancelled).toBe(true);
}, 10_000);

test("cancel_turn returns 404 session_not_live for unknown session", async () => {
  const ctx = makeCtx();
  const req = new Request("http://x/v1/cancel_turn", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Adapter-Id": "test" },
    body: JSON.stringify({ session_id: "44444444-4444-4444-8444-444444444444" }),
  });
  const res = await cancelTurnHandler(req, ctx, {});
  expect(res.status).toBe(404);
  const body = await res.json() as any;
  expect(body.error).toBe("session_not_live");
});
