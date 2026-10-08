import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createHarness, waitFor, waitForSent, waitForSpawn, ADMIN_TOKEN, OTHER_ADAPTER_TOKEN, type Harness } from "./harness";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.shutdown();
});

const KEY = () => randomUUID();
const BODY = (extra: object = {}) => ({
  adapter_ref: "ref-" + Math.random().toString(36).slice(2, 8),
  prompt: "say hi",
  ...extra,
});

/**
 * Drive the full open flow to a "live + first turn replied" state. The
 * launcher resolves once the worker stays up through its grace window and
 * runTurn waits for the result — emit it the way a real worker would.
 */
async function openAndDriveLive(extra: object = {}) {
  const open = await h.api("POST", "/v1/open_session", BODY(extra), {
    "Idempotency-Key": KEY(),
  });
  const sid: string = open.body.session_id;
  await waitForSpawn(h, sid);
  await waitForSent(h, sid, 1);
  h.runtime.emitResult(sid, "hi");
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

async function waitLive(sid: string) {
  await waitFor(async () => {
    const r = await h.api("GET", `/v1/sessions/${sid}`);
    return r.body.session?.status === "live";
  });
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

    // launcher spawned a worker for the session, in its own workdir
    await waitForSpawn(h, sid);
    const spawn = h.runtime.spawns.find((s) => s.sessionId === sid)!;
    expect(spawn.mode).toBe("new");
    expect(spawn.cwd).toContain(join("workdirs", sid));

    // sessions/{id} returns nested {session: {...}} plus worker liveness
    const show = await h.api("GET", `/v1/sessions/${sid}`);
    expect(show.status).toBe(200);
    expect(["launching", "live", "recovering"]).toContain(show.body.session.status);
    expect(show.body.worker.alive).toBe(true);

    // session_open_acknowledged is the first webhook (synchronous insert)
    await waitFor(
      () => h.webhooks.some((w) => w.event_type === "session_open_acknowledged" && w.session_id === sid),
      3_000,
    );

    // the worker stays up through the launch grace → session_live
    await waitFor(
      () => h.webhooks.some((w) => w.event_type === "session_live" && w.session_id === sid),
      3_000,
    );

    // runTurn sent the first prompt to the worker; satisfy it with a result
    await waitForSent(h, sid, 1);
    expect(h.runtime.workers.get(sid)!.sent[0]).toBe("say hi");
    h.runtime.emitResult(sid, "hi");
    await waitFor(
      () => h.webhooks.some((w) => w.event_type === "turn_replied" && w.session_id === sid),
      3_000,
    );
    const replied = h.webhooks.find((w) => w.event_type === "turn_replied" && w.session_id === sid);
    expect(replied!.payload.reply).toBe("hi");
  });

  test("tool uses announced by the worker fan out as tool_call webhooks", async () => {
    const { sid } = await openAndDriveLive();
    h.runtime.emitAssistant(sid, "", [{ id: "toolu_1", name: "Bash", input: { command: "ls" } }]);
    const call = await waitFor(
      () => h.webhooks.find((w) => w.event_type === "tool_call" && w.session_id === sid),
      3_000,
    );
    expect(call.payload.tool_name).toBe("Bash");
    expect(call.payload.tool_input).toEqual({ command: "ls" });
  });
});

describe("Flow 2: send_turn on a live session", () => {
  test("send_turn enqueues and replies via the result event", async () => {
    const { sid } = await openAndDriveLive();
    await waitLive(sid);

    const send = await h.api(
      "POST",
      "/v1/send_turn",
      { session_id: sid, prompt: "second" },
      { "Idempotency-Key": KEY() },
    );
    expect(send.status).toBe(202);
    expect(send.body.session_id).toBe(sid);

    await waitForSent(h, sid, 2);
    h.runtime.emitResult(sid, "two");
    await waitFor(
      () =>
        h.webhooks.filter((w) => w.event_type === "turn_replied" && w.session_id === sid).length >= 2,
      3_000,
    );
  });

  test("an error result fails the turn with turn_failed and the session stays live", async () => {
    const { sid } = await openAndDriveLive();
    await waitLive(sid);
    const send = await h.api("POST", "/v1/send_turn", { session_id: sid, prompt: "boom" }, { "Idempotency-Key": KEY() });
    await waitForSent(h, sid, 2);
    h.runtime.emitResult(sid, "API error 529", { subtype: "error_during_execution", is_error: true });
    const failed = await waitFor(
      () => h.webhooks.find((w) => w.event_type === "turn_failed" && w.session_id === sid),
      3_000,
    );
    expect(failed.payload.turn_id).toBe(send.body.turn_id);
    expect(failed.payload.error).toContain("API error 529");
    const show = await h.api("GET", `/v1/sessions/${sid}`);
    expect(show.body.session.status).toBe("live");
  });
});

describe("Flow 3: cancel_turn", () => {
  test("cancel_turn interrupts the worker and returns 200", async () => {
    const { sid } = await openAndDriveLive();
    await waitLive(sid);

    // Kick a second send_turn so there is a real in-flight runTurn waiting on
    // a result. Then cancel — cancelTurn waits for the aborted result claude
    // emits after an interrupt; emit it promptly.
    await h.api(
      "POST",
      "/v1/send_turn",
      { session_id: sid, prompt: "do work" },
      { "Idempotency-Key": KEY() },
    );
    await waitForSent(h, sid, 2);
    h.runtime.emitAssistant(sid, "partial");

    const cancelP = h.api(
      "POST",
      "/v1/cancel_turn",
      { session_id: sid },
      { "Idempotency-Key": KEY() },
    );
    await waitFor(() => h.runtime.workers.get(sid)!.interrupts >= 1);
    h.runtime.emitResult(sid, "", { subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" });

    const cancel = await cancelP;
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelled).toBe(true);
    expect(cancel.body.partial_text).toBe("partial");
    expect(h.runtime.workers.get(sid)!.killed).toEqual([]);
  }, 10_000);
});

describe("Flow 4: close_session", () => {
  test("close_session ends the worker's stdin and fires session_closed", async () => {
    const { sid } = await openAndDriveLive();
    await waitLive(sid);

    const close = await h.api(
      "POST",
      "/v1/close_session",
      { session_id: sid },
      { "Idempotency-Key": KEY() },
    );
    expect(close.status).toBe(200);

    await waitFor(
      () => h.webhooks.some((w) => w.event_type === "session_closed" && w.session_id === sid),
      5_000,
    );
    // Graceful path: stdin closed, the fake worker exits on its own, no signal.
    const w = h.runtime.workers.get(sid)!;
    expect(w.ended).toBe(true);
    expect(w.alive).toBe(false);
    expect(w.killed).toEqual([]);
  }, 10_000);
});

describe("Flow 5: recycle_session", () => {
  test("recycle preserves adapter_ref + rotates session_id", async () => {
    const ref = "recycle-ref-" + Math.random().toString(36).slice(2, 8);
    const { sid: sid1 } = await openAndDriveLive({ adapter_ref: ref });
    await waitLive(sid1);

    // recycler closes the old worker, then launches a new id.
    const recycleP = h.api(
      "POST",
      "/v1/recycle_session",
      { session_id: sid1 },
      { "Idempotency-Key": KEY() },
    );
    const newId = (await waitFor(() => {
      const fresh = h.runtime.spawns.find((s) => s.sessionId !== sid1);
      return fresh ? fresh.sessionId : false;
    }, 5_000)) as string;

    const recycle = await recycleP;
    expect(recycle.status).toBe(202);
    expect(recycle.body.old_session_id).toBe(sid1);
    expect(recycle.body.new_session_id).toBe(newId);

    const show = await h.api("GET", `/v1/sessions/${newId}`);
    expect(show.body.session.adapter_ref).toBe(ref);
    expect(h.runtime.workers.get(sid1)!.alive).toBe(false);
  }, 15_000);
});

describe("Flow 6: reclaim + resume", () => {
  // openSessionHandler only reclaims sessions in `recovering` status. The
  // watchdog flips live -> dead, never recovering, so we seed the row via the
  // exposed db handle to exercise the reclaim path.
  test("second open with same adapter_ref reclaims a recovering session", async () => {
    const ref = "reclaim-ref-" + Math.random().toString(36).slice(2, 8);
    const sid = randomUUID();
    const now = Date.now();
    h.db.raw.run(
      `INSERT INTO sessions
        (id, adapter_id, adapter_ref, status, cwd, mcp_bundle,
         webhook_url, created_at, updated_at, recovery_expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [sid, "test", ref, "recovering", "/tmp/recov-cwd", "", h.webhookUrl, now, now, now + 600_000],
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

  test("resume_session relaunches the worker with --resume and the session goes live again", async () => {
    const sid = randomUUID();
    const now = Date.now();
    h.db.raw.run(
      `INSERT INTO sessions
        (id, adapter_id, adapter_ref, status, cwd, mcp_bundle, webhook_url, created_at, updated_at, recovery_expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [sid, "test", "resume-ref", "recovering", "/tmp/recov-cwd", "", h.webhookUrl, now, now, now + 600_000],
    );
    const resumeP = h.api("POST", "/v1/resume_session", { session_id: sid }, { "Idempotency-Key": KEY() });
    await waitForSpawn(h, sid);
    expect(h.runtime.spawns.find((s) => s.sessionId === sid)!.mode).toBe("resume");
    const resumed = await resumeP;
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe("live");
    await waitFor(() => h.webhooks.some((w) => w.event_type === "session_resumed" && w.session_id === sid), 3_000);

    // The resumed session takes turns like any other.
    const send = await h.api("POST", "/v1/send_turn", { session_id: sid, prompt: "again" }, { "Idempotency-Key": KEY() });
    expect(send.status).toBe(202);
    await waitForSent(h, sid, 1);
    h.runtime.emitResult(sid, "back");
    const replied = await waitFor(() => h.webhooks.find((w) => w.event_type === "turn_replied" && w.session_id === sid), 3_000);
    expect(replied.payload.reply).toBe("back");
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
    await waitLive(sid);

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
        `INSERT INTO sessions (id, adapter_id, adapter_ref, status, cwd, mcp_bundle, webhook_url, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [sid, id, `ref-${id}`, "live", `/tmp/cwd-${id}`, "", h.webhookUrl, now, now],
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

describe("Flow 7: limit/quota -> pause", () => {
  test("a result matching warning_regex auto-pauses the daemon", async () => {
    const { sid } = await openAndDriveLive();
    const before = await h.api("GET", "/v1/status", undefined, { Authorization: `Bearer ${ADMIN_TOKEN}` });
    expect(before.body.mode).toBe("running");

    // A late result (e.g. one landing after a turn timeout) whose text trips
    // the harness warning_regex ("approaching"). bus.emit is synchronous, so
    // the pause is observable immediately.
    h.runtime.emitResult(sid, "You are approaching your usage limit — resets at 5pm.");

    const after = await h.api("GET", "/v1/status", undefined, { Authorization: `Bearer ${ADMIN_TOKEN}` });
    expect(after.body.mode).toBe("paused");
  }, 15_000);

  test("a non-allowed rate_limit_event from claude auto-pauses the daemon", async () => {
    const { sid } = await openAndDriveLive();
    h.runtime.emitRateLimit(sid, "allowed", { utilization: 0.4 });
    expect((await h.api("GET", "/v1/status", undefined, { Authorization: `Bearer ${ADMIN_TOKEN}` })).body.mode).toBe("running");
    h.runtime.emitRateLimit(sid, "rejected", { rate_limit_type: "five_hour", utilization: 1 });
    expect((await h.api("GET", "/v1/status", undefined, { Authorization: `Bearer ${ADMIN_TOKEN}` })).body.mode).toBe("paused");
  }, 15_000);
});
