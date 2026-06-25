import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createHarness, waitFor, ADMIN_TOKEN, OTHER_ADAPTER_TOKEN, type Harness } from "./harness";
import { randomUUID } from "node:crypto";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.shutdown();
});

const KEY = () => randomUUID();
const BODY = (extra: object = {}) => ({
  adapter_id: "test",
  adapter_ref: "ref-" + Math.random().toString(36).slice(2, 8),
  prompt: "say hi",
  webhook_url: h.webhookUrl,
  ...extra,
});

/**
 * Drive the full open flow to a "live + first turn replied" state. The
 * launcher waits for SessionStart and runTurn waits for Stop — emit both.
 */
async function openAndDriveLive(extra: object = {}, body?: { prompt?: string }) {
  const open = await h.api("POST", "/v1/open_session", BODY({ ...extra, ...body }), {
    "Idempotency-Key": KEY(),
  });
  const sid: string = open.body.session_id;
  // Launcher subscribes synchronously inside the async open path; nudge a
  // tick so its handler is registered before we emit SessionStart.
  await waitFor(() => h.fakeTmux.calls.some((c) => c.method === "newSession"));
  h.emitHookEvent({ hook_event_name: "SessionStart" as any, session_id: sid });
  // Wait for runTurn to issue the prompt (sendKeysLiteral) — confirms its
  // Stop subscription is in place — then satisfy with Stop.
  await waitFor(() =>
    h.fakeTmux.calls.some(
      (c) => c.method === "sendKeysLiteral" && (c.args as any[])[0]?.toString().startsWith("para-raid-"),
    ),
  );
  h.emitHookEvent({
    hook_event_name: "Stop" as any,
    session_id: sid,
    last_assistant_message: "hi",
  });
  // Wait for the open-session async path to settle by polling the turns row
  // for status = 'completed'. This avoids waiting on the publisher's 1s tick
  // for webhook delivery, keeping the integration suite under 10s wall-clock.
  await waitFor(() => {
    const row = h.db.raw
      .query<{ status: string }, [string]>(
        "SELECT status FROM turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(sid) as { status: string } | null;
    return row?.status === "completed";
  }, 3_000);
  return { open, sid };
}

describe("Flow 1: open_session lifecycle", () => {
  test("open_session returns 202 and async fires session_live + turn_replied", async () => {
    const open = await h.api("POST", "/v1/open_session", BODY(), {
      "Idempotency-Key": KEY(),
    });
    expect(open.status).toBe(202);
    const sid: string = open.body.session_id;
    expect(sid).toMatch(/[0-9a-f-]{36}/);
    expect(typeof open.body.turn_id).toBe("string");

    // launcher invoked tmux.newSession
    await waitFor(() => h.fakeTmux.calls.some((c) => c.method === "newSession"));

    // sessions/{id} returns nested {session: {...}}
    const show = await h.api("GET", `/v1/sessions/${sid}`);
    expect(show.status).toBe(200);
    expect(["launching", "live", "recovering"]).toContain(show.body.session.status);

    // session_open_acknowledged is the first webhook (synchronous insert)
    await waitFor(
      () => h.webhooks.some((w) => w.event_type === "session_open_acknowledged" && w.session_id === sid),
      3_000,
    );

    // SessionStart unblocks the launcher → session_live
    h.emitHookEvent({ hook_event_name: "SessionStart" as any, session_id: sid });
    await waitFor(
      () => h.webhooks.some((w) => w.event_type === "session_live" && w.session_id === sid),
      3_000,
    );

    // runTurn dispatches the first prompt; satisfy its Stop subscription
    await waitFor(() =>
      h.fakeTmux.calls.some(
        (c) => c.method === "sendKeysLiteral" && (c.args as any[])[0]?.toString().startsWith("para-raid-"),
      ),
    );
    h.emitHookEvent({
      hook_event_name: "Stop" as any,
      session_id: sid,
      last_assistant_message: "hi",
    });
    await waitFor(
      () => h.webhooks.some((w) => w.event_type === "turn_replied" && w.session_id === sid),
      3_000,
    );
    const replied = h.webhooks.find((w) => w.event_type === "turn_replied" && w.session_id === sid);
    expect(replied!.payload.reply).toBe("hi");
  });
});

describe("Flow 2: send_turn on a live session", () => {
  test("send_turn enqueues and replies via Stop event", async () => {
    const { sid } = await openAndDriveLive();

    // Wait until session row reaches `live` status (handler requires it).
    await waitFor(async () => {
      const r = await h.api("GET", `/v1/sessions/${sid}`);
      return r.body.session?.status === "live";
    });

    const send = await h.api(
      "POST",
      "/v1/send_turn",
      { session_id: sid, prompt: "second" },
      { "Idempotency-Key": KEY() },
    );
    expect(send.status).toBe(202);
    expect(send.body.session_id).toBe(sid);

    // Wait until runTurn for the second prompt has registered its Stop sub.
    await waitFor(
      () => h.fakeTmux.calls.filter((c) => c.method === "sendKeysLiteral").length >= 2,
    );
    h.emitHookEvent({
      hook_event_name: "Stop" as any,
      session_id: sid,
      last_assistant_message: "two",
    });
    await waitFor(
      () =>
        h.webhooks.filter((w) => w.event_type === "turn_replied" && w.session_id === sid).length >= 2,
      3_000,
    );
  });
});

describe("Flow 3: cancel_turn", () => {
  test("cancel_turn sends ESC and returns 200", async () => {
    const { sid } = await openAndDriveLive();

    await waitFor(async () => {
      const r = await h.api("GET", `/v1/sessions/${sid}`);
      return r.body.session?.status === "live";
    });

    // Kick a second send_turn so there is a real in-flight runTurn waiting on
    // Stop. Then cancel — cancelTurn races a Stop subscription; emit Stop
    // promptly so it returns within escapeWaitMs (3s default).
    await h.api(
      "POST",
      "/v1/send_turn",
      { session_id: sid, prompt: "do work" },
      { "Idempotency-Key": KEY() },
    );
    await waitFor(
      () => h.fakeTmux.calls.filter((c) => c.method === "sendKeysLiteral").length >= 2,
    );

    const cancelP = h.api(
      "POST",
      "/v1/cancel_turn",
      { session_id: sid },
      { "Idempotency-Key": KEY() },
    );
    // Emit Stop quickly so cancelTurn observes it and avoids ctrl-c escalation.
    setTimeout(() => {
      h.emitHookEvent({
        hook_event_name: "Stop" as any,
        session_id: sid,
        last_assistant_message: "partial",
      });
    }, 50);

    const cancel = await cancelP;
    expect(cancel.status).toBe(200);
    expect(h.fakeTmux.calls.some((c) => c.method === "sendEscape")).toBe(true);
    expect(cancel.body.cancelled).toBe(true);
  }, 10_000);
});

describe("Flow 4: close_session", () => {
  test("close_session graceful then kill, fires session_closed", async () => {
    const { sid } = await openAndDriveLive();
    await waitFor(async () => {
      const r = await h.api("GET", `/v1/sessions/${sid}`);
      return r.body.session?.status === "live";
    });

    const close = await h.api(
      "POST",
      "/v1/close_session",
      { session_id: sid },
      { "Idempotency-Key": KEY() },
    );
    expect(close.status).toBe(200);

    // closer.ts sends "/exit" + Enter, then waits up to 10s for SessionEnd.
    // Emit SessionEnd to short-circuit the timeout path.
    h.emitHookEvent({ hook_event_name: "SessionEnd" as any, session_id: sid });

    await waitFor(
      () => h.webhooks.some((w) => w.event_type === "session_closed" && w.session_id === sid),
      5_000,
    );
    // Graceful path used /exit via sendKeysLiteral; killSession only fires on
    // timeout. With SessionEnd promptly emitted, no kill is needed.
    expect(
      h.fakeTmux.calls.some(
        (c) => c.method === "sendKeysLiteral" && (c.args as any[])[1] === "/exit",
      ),
    ).toBe(true);
  }, 10_000);
});

describe("Flow 5: recycle_session", () => {
  test("recycle preserves adapter_ref + rotates session_id", async () => {
    const ref = "recycle-ref-" + Math.random().toString(36).slice(2, 8);
    const { sid: sid1 } = await openAndDriveLive({ adapter_ref: ref });
    await waitFor(async () => {
      const r = await h.api("GET", `/v1/sessions/${sid1}`);
      return r.body.session?.status === "live";
    });

    // recycler.closeSession waits for SessionEnd, then launches a new id and
    // waits for SessionStart. Drive both so the handler can complete.
    const recycleP = h.api(
      "POST",
      "/v1/recycle_session",
      { session_id: sid1 },
      { "Idempotency-Key": KEY() },
    );
    setTimeout(() => {
      h.emitHookEvent({ hook_event_name: "SessionEnd" as any, session_id: sid1 });
    }, 50);
    // The recycler issues a fresh tmux.newSession with --session-id <newId>
    // baked into the launch command. Extract the new id from FakeTmux call
    // history once the recycler-driven newSession appears.
    const newId = (await waitFor(() => {
      // After our initial open we have one newSession call. The recycler
      // produces a second one for the same tmux pane name.
      const news = h.fakeTmux.calls.filter((c) => c.method === "newSession");
      if (news.length < 2) return false;
      const cmd = (news[news.length - 1].args as any[])[2] as string;
      const m = cmd.match(/--session-id ([0-9a-f-]{36})/);
      return m ? m[1] : false;
    }, 5_000)) as string;
    h.emitHookEvent({ hook_event_name: "SessionStart" as any, session_id: newId });

    const recycle = await recycleP;
    expect(recycle.status).toBe(202);
    expect(recycle.body.old_session_id).toBe(sid1);
    expect(recycle.body.new_session_id).toBe(newId);

    const show = await h.api("GET", `/v1/sessions/${newId}`);
    expect(show.body.session.adapter_ref).toBe(ref);
  }, 15_000);
});

describe("Flow 6: reclaim", () => {
  // Plan-defect: openSessionHandler only reclaims sessions in `recovering`
  // status (NOT `live` — the plan's flow expected live). The handler returns
  // 200 with the existing id and enqueues `session_recover_candidate`.
  // Watchdog flips live -> dead, never recovering, so we seed the row via
  // the exposed db handle to exercise the reclaim path.
  test("second open with same adapter_ref reclaims a recovering session", async () => {
    const ref = "reclaim-ref-" + Math.random().toString(36).slice(2, 8);
    const sid = randomUUID();
    const now = Date.now();
    h.db.raw.run(
      `INSERT INTO sessions
        (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle,
         webhook_url, created_at, updated_at, recovery_expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [sid, "test", ref, "recovering", `tmx-${sid.slice(0,8)}`, "/tmp/recov-cwd", "", h.webhookUrl, now, now, now + 600_000],
    );

    const second = await h.api(
      "POST",
      "/v1/open_session",
      BODY({ adapter_ref: ref }),
      { "Idempotency-Key": KEY() },
    );
    expect(second.status).toBe(200);
    expect(second.body.session_id).toBe(sid);
    expect(second.body.status).toBe("recovering");
    await waitFor(
      () =>
        h.webhooks.some(
          (w) => w.event_type === "session_recover_candidate" && w.session_id === sid,
        ),
      3_000,
    );
  }, 10_000);
});

describe("Flow 8: per-adapter identity + ACL", () => {
  test("missing/invalid bearer token is 401; wrong-owner adapter is 403; admin can; owner can", async () => {
    // No token at all → 401.
    const noAuth = await h.api("GET", "/v1/sessions", undefined, { Authorization: "" });
    expect(noAuth.status).toBe(401);

    // Invalid token → 401.
    const badAuth = await h.api("GET", "/v1/sessions", undefined, { Authorization: "Bearer not-a-real-token" });
    expect(badAuth.status).toBe(401);

    // Open a session as the default ("test") adapter.
    const { sid } = await openAndDriveLive();
    await waitFor(async () => {
      const r = await h.api("GET", `/v1/sessions/${sid}`);
      return r.body.session?.status === "live";
    });

    // A different authenticated adapter ("other") cannot drive test's session.
    const intruder = await h.api(
      "POST", "/v1/send_turn", { session_id: sid, prompt: "mine now" },
      { "Idempotency-Key": KEY(), Authorization: `Bearer ${OTHER_ADAPTER_TOKEN}` },
    );
    expect(intruder.status).toBe(403);

    // Admin may close any session.
    const adminClose = await h.api(
      "POST", "/v1/close_session", { session_id: sid },
      { "Idempotency-Key": KEY(), Authorization: `Bearer ${ADMIN_TOKEN}` },
    );
    expect(adminClose.status).toBe(200);
  }, 15_000);

  test("admin-only ops reject a regular adapter; sessions-list is scoped per adapter", async () => {
    // status requires admin → 403 for the default adapter token.
    const statusAsAdapter = await h.api("GET", "/v1/status");
    expect(statusAsAdapter.status).toBe(403);
    const statusAsAdmin = await h.api("GET", "/v1/status", undefined, { Authorization: `Bearer ${ADMIN_TOKEN}` });
    expect(statusAsAdmin.status).toBe(200);

    // Seed one session for each adapter.
    const now = Date.now();
    for (const [id, sid] of [["test", randomUUID()], ["other", randomUUID()]] as const) {
      h.db.raw.run(
        `INSERT INTO sessions (id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [sid, id, `ref-${id}`, "live", `tmx-${id}`, `/tmp/cwd-${id}`, "", h.webhookUrl, now, now],
      );
    }
    // Default adapter ("test") only sees its own row even though it asks for all.
    const scoped = await h.api("GET", "/v1/sessions");
    expect(scoped.body.sessions.every((s: any) => s.adapter_id === "test")).toBe(true);
    expect(scoped.body.sessions.some((s: any) => s.adapter_id === "other")).toBe(false);

    // Admin sees both.
    const all = await h.api("GET", "/v1/sessions", undefined, { Authorization: `Bearer ${ADMIN_TOKEN}` });
    const ids = new Set(all.body.sessions.map((s: any) => s.adapter_id));
    expect(ids.has("test")).toBe(true);
    expect(ids.has("other")).toBe(true);
  });
});

describe("Flow 7: limit/quota warning -> pause", () => {
  // Plan-defect (carry-over): warning_regex auto-pause is NOT wired in any
  // hot path. `src/limit/warning-scanner.ts` exposes scanForWarning() but no
  // caller invokes it on Stop events, so `paused` never flips automatically
  // from a hook event today. Wave 9 carry-over.
  test.todo(
    "Stop event matching warning_regex auto-pauses the daemon (Wave 9 carry-over: warning-scanner not wired into Stop path)",
    () => {},
  );
});
