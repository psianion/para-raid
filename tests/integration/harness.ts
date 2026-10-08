import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createDb } from "../../src/db";
import { createEventBus } from "../../src/events/bus";
import { createFakeRuntime, type FakeRuntime } from "../../src/worker/fake";
import { createDispatcher } from "../../src/sessions/dispatcher";
import { startPublisher } from "../../src/publisher/outbox";
import { createModeController } from "../../src/limit/mode-controller";
import { compileWarningRegex, watchRateLimitEvents, watchResultEventsForWarning } from "../../src/limit/warning-scanner";
import { reconcileOnBoot } from "../../src/recovery/boot";
import { startGraceTimer } from "../../src/recovery/grace";
import { startWatchdog } from "../../src/recovery/watchdog";
import { createRouter } from "../../src/api/router";
import { routes } from "../../src/api/routes";
import { runTurn } from "../../src/sessions/turn-runner";
import { launchDefaults } from "../../src/sessions/launcher";
import { enqueueWebhook } from "../../src/publisher/enqueue";
import type { ParaRaidConfig } from "../../src/types";
import type { WorkerEvent } from "../../src/worker/runtime";

export interface CapturedWebhook {
  event_type: string;
  session_id: string;
  payload: any;
  ts: number;
}

export interface Harness {
  socket: string;
  webhookUrl: string;
  webhooks: CapturedWebhook[];
  db: ReturnType<typeof createDb>;
  bus: ReturnType<typeof createEventBus>;
  runtime: FakeRuntime;
  api: (
    method: "GET" | "POST",
    path: string,
    body?: any,
    headers?: Record<string, string>,
  ) => Promise<{ status: number; headers: Headers; body: any }>;
  shutdown: () => Promise<void>;
}

// Fixed test secrets — bearer mode derives identity from these.
export const ADMIN_TOKEN = "admin-token-0123456789abcdef0123456789abcdef";
export const TEST_ADAPTER_TOKEN = "test-adapter-token-0123456789abcdef0123";
export const OTHER_ADAPTER_TOKEN = "other-adapter-token-0123456789abcdef012";

export async function createHarness(opts?: {
  graceWindowMs?: number;
  signing?: { mode: "none" | "hmac"; secret?: string };
  webhookUrl?: string;
}): Promise<Harness> {
  const root = `/tmp/para-raid-it-${randomUUID().slice(0, 8)}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(`${root}/workdirs`, { recursive: true });

  const webhooks: CapturedWebhook[] = [];
  const webhookPort = 19000 + Math.floor(Math.random() * 1000);
  const webhookServer = Bun.serve({
    port: webhookPort,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const body = (await req.json()) as any;
      webhooks.push({
        event_type: body.event_type,
        session_id: body.session_id,
        payload: body,
        ts: Date.now(),
      });
      return new Response("ok");
    },
  });
  // Point the adapters at an external receiver when one is supplied (the
  // reference-adapter e2e does this); otherwise use the built-in capture server.
  const webhookUrl = opts?.webhookUrl ?? `http://127.0.0.1:${webhookPort}/hook`;

  const db = createDb(":memory:");
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  const log = { info: () => {}, warn: () => {}, error: () => {} } as any;
  const modeController = createModeController();

  const dispatcher = createDispatcher({
    maxConcurrentTurns: 3,
    onDispatch: (job) =>
      runTurn({ session_id: job.session_id, prompt: job.prompt }, { runtime, bus, timeoutMs: 5_000 }),
  });

  const config: ParaRaidConfig = {
    daemon: { data_dir: root, socket_path: `${root}/api.sock` } as any,
    concurrency: { max_concurrent_turns: 3, max_total_sessions: 10 } as any,
    recovery: { grace_window_ms: opts?.graceWindowMs ?? 200 } as any,
    publisher: { retry_window_ms: 60_000, backoff_ms: [50] } as any,
    limit: { warning_regex: "approaching", pause_on_rate_limit: true } as any,
    // Bearer auth so per-adapter identity is exercised end-to-end.
    auth: { mode: "bearer", token: ADMIN_TOKEN } as any,
    signing: (opts?.signing ?? "none") as any,
    adapters: {
      test: { webhook_url: webhookUrl, token: TEST_ADAPTER_TOKEN },
      other: { webhook_url: webhookUrl, token: OTHER_ADAPTER_TOKEN },
    } as any,
  } as any;

  // Workers are fakes: no need to watch 1.5s for an early exit per launch.
  launchDefaults.readyGraceMs = 30;

  const ctx: any = { db, bus, runtime, logger: log, config, modeController, dispatcher };

  // Same bus wiring the real daemon boot does.
  watchResultEventsForWarning(bus, compileWarningRegex(config.limit.warning_regex), modeController, log);
  watchRateLimitEvents(bus, modeController, log);
  bus.subscribe((event: WorkerEvent) => {
    if (event.type !== "assistant" || event.tool_uses.length === 0) return;
    const row = db.raw.query<{ adapter_id: string; webhook_url: string }, [string]>(
      "SELECT adapter_id, webhook_url FROM sessions WHERE id = ?",
    ).get(event.session_id) as { adapter_id: string; webhook_url: string } | null;
    if (!row) return;
    for (const tu of event.tool_uses) {
      enqueueWebhook(db, { eventType: "tool_call", sessionId: event.session_id, adapterId: row.adapter_id, webhookUrl: row.webhook_url, payload: { tool_name: tu.name, tool_input: tu.input } });
    }
  });

  await reconcileOnBoot(ctx);

  const publisher = startPublisher(db, config.publisher as any, log, opts?.signing);
  const grace = startGraceTimer(ctx, 50);
  const watchdog = startWatchdog(ctx, 100);
  const router = createRouter(routes, ctx);
  const apiServer = Bun.serve({ unix: `${root}/api.sock`, fetch: router } as any);

  return {
    socket: `${root}/api.sock`,
    webhookUrl,
    db,
    bus,
    webhooks,
    runtime,
    api: async (method, path, body, headers) => {
      const init: any = {
        method,
        // Default to the "test" adapter's bearer token; a caller can override
        // Authorization (e.g. the admin token) via the headers arg.
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_ADAPTER_TOKEN}`, ...(headers ?? {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        unix: `${root}/api.sock`,
      };
      const r = await fetch(`http://x${path}`, init);
      const text = await r.text();
      return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : {} };
    },
    shutdown: async () => {
      await apiServer.stop();
      webhookServer.stop();
      watchdog.stop();
      grace.stop();
      publisher.stop();
      dispatcher.stop();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(
  fn: () => T | undefined | null | false,
  deadlineMs = 2_000,
  pollMs = 20,
): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor: deadline ${deadlineMs}ms`);
}

/** The worker for `sid` has been spawned (launchSession is waiting on init). */
export async function waitForSpawn(h: Harness, sid: string): Promise<void> {
  await waitFor(() => h.runtime.workers.has(sid));
}

/** The worker for `sid` has received its Nth prompt (runTurn is waiting on a result). */
export async function waitForSent(h: Harness, sid: string, count: number): Promise<void> {
  await waitFor(() => (h.runtime.workers.get(sid)?.sent.length ?? 0) >= count);
}
