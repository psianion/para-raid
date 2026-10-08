// src/daemon.ts — Para-RAID daemon entrypoint.
import { existsSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "./config/loader";
import { loadBundles } from "./bundles/loader";
import { checkClaudeLogin, checkAuthSecurity, checkSigningSecurity } from "./bin/doctor";
import { createDb } from "./db";
import { createEventBus } from "./events/bus";
import { createClaudeRuntime } from "./worker/claude";
import { createDispatcher } from "./sessions/dispatcher";
import { startPublisher } from "./publisher/outbox";
import { createModeController } from "./limit/mode-controller";
import { startRamValve } from "./limit/ram-valve";
import { compileWarningRegex, pauseIfLimitReached, watchRateLimitEvents, watchResultEventsForWarning } from "./limit/warning-scanner";
import { reconcileOnBoot } from "./recovery/boot";
import { startGraceTimer } from "./recovery/grace";
import { startWatchdog } from "./recovery/watchdog";
import { createRouter } from "./api/router";
import { routes } from "./api/routes";
import { createLogger } from "./logger";
import { runTurn } from "./sessions/turn-runner";
import { enqueueWebhook } from "./publisher/enqueue";
import type { WorkerEvent } from "./worker/runtime";

async function main() {
  const log = createLogger();
  const configPath = process.env.PARARAID_CONFIG ?? join(homedir(), ".config/para-raid/config.toml");
  const config = loadConfig(configPath);
  log.info("daemon.boot.start", { config_path: configPath, socket: config.daemon.socket_path });

  // Boot gate: without a logged-in claude, every session would die at launch.
  // Fail fast with an actionable message instead.
  const login = await checkClaudeLogin();
  if (!login.pass) {
    log.error("daemon.boot.fail", { reason: "claude_not_logged_in", detail: login.msg });
    process.exit(1);
  }
  log.info("daemon.boot.claude_ok", { detail: login.msg });

  // Secure-by-default: refuse to boot on an insecure auth config (bearer with no
  // real token, or the unimplemented mtls mode) rather than serve unprotected.
  const sec = checkAuthSecurity(config.auth, config.adapters);
  if (!sec.pass) {
    log.error("daemon.boot.fail", { reason: "insecure_auth_config", detail: sec.msg });
    process.exit(1);
  }
  log.info("daemon.boot.auth_ok", { detail: sec.msg });

  const sig = checkSigningSecurity(config.signing);
  if (!sig.pass) {
    log.error("daemon.boot.fail", { reason: "insecure_signing_config", detail: sig.msg });
    process.exit(1);
  }

  const dbPath = join(config.daemon.data_dir, "para-raid.db");
  const bundlesPath = join(dirname(configPath), "mcp-bundles.toml");
  const bundles = existsSync(bundlesPath) ? loadBundles(bundlesPath) : [];
  const db = createDb(dbPath);
  const bus = createEventBus();
  const runtime = createClaudeRuntime({
    bus, logger: log,
    envSetup: config.claude.env_setup,
    model: config.claude.model || undefined,
    extraArgs: config.claude.extra_args,
  });
  const modeController = createModeController();
  // Quota self-pause: scan each completed turn's reply for claude's usage-limit
  // warnings and pause the daemon so it stops spending quota. (Empty pattern → off.)
  const limitRegex = compileWarningRegex(config.limit.warning_regex);

  const dispatcher = createDispatcher({
    maxConcurrentTurns: config.concurrency.max_concurrent_turns,
    onDispatch: async (job) => {
      const reply = await runTurn(job, { runtime, bus, timeoutMs: config.concurrency.turn_timeout_ms });
      pauseIfLimitReached(reply, limitRegex, modeController, log);
      return reply;
    },
  });

  const ctx = { db, bus, runtime, logger: log, config, modeController, dispatcher, bundles };

  await reconcileOnBoot(ctx);

  // Also scan result events directly: the onDispatch scan above only sees
  // dispatcher-run turns and misses a result that lands after a turn timeout.
  watchResultEventsForWarning(bus, limitRegex, modeController, log);
  // claude tells us its quota state after every turn; a non-allowed status
  // pauses before the next turn fails.
  if (config.limit.pause_on_rate_limit) watchRateLimitEvents(bus, modeController, log);

  // Fire a `tool_call` webhook for every tool use the worker announces, so
  // adapters can observe (not gate) each tool a session runs.
  bus.subscribe((event: WorkerEvent) => {
    if (event.type !== "assistant" || event.tool_uses.length === 0) return;
    const row = db.raw.query<{ adapter_id: string; webhook_url: string }, [string]>(
      "SELECT adapter_id, webhook_url FROM sessions WHERE id = ?",
    ).get(event.session_id) as { adapter_id: string; webhook_url: string } | null;
    if (!row || !row.webhook_url) return;
    for (const tu of event.tool_uses) {
      enqueueWebhook(db, {
        eventType: "tool_call",
        sessionId: event.session_id,
        adapterId: row.adapter_id,
        webhookUrl: row.webhook_url,
        payload: { tool_name: tu.name, tool_input: tu.input },
      });
    }
  });

  const publisher = startPublisher(db, config.publisher, log, config.signing);
  const grace = startGraceTimer(ctx, 1_000);
  const watchdog = startWatchdog(ctx, 5_000);
  const ramValve = startRamValve(modeController, {
    warnPct: config.observability.ram_warn_pct,
    refusePct: config.observability.ram_refuse_pct,
    intervalMs: config.observability.stats_interval_ms,
  }, log);

  // Owner-only dir first, so the socket is never reachable even during the brief
  // window before its own mode is tightened (in "none" mode this is the only guard).
  mkdirSync(dirname(config.daemon.socket_path), { recursive: true, mode: 0o700 });
  if (existsSync(config.daemon.socket_path)) rmSync(config.daemon.socket_path);
  const router = createRouter(routes, ctx);
  const apiServer = Bun.serve({ unix: config.daemon.socket_path, fetch: router } as any);
  chmodSync(config.daemon.socket_path, 0o600); // owner-only: defense in depth even on a private box
  log.info("daemon.boot.ready", { socket: config.daemon.socket_path });

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("daemon.shutdown.start", { signal: sig });
    // 1) stop accepting new requests
    await apiServer.stop();
    // 2) stop accepting new dispatches
    dispatcher.stop();
    // 3) recovery timers
    ramValve.stop();
    watchdog.stop();
    grace.stop();
    // 4) publisher
    publisher.stop();
    // 5) workers: close stdin so each claude exits cleanly; whatever is still
    //    alive after a short grace gets SIGTERM. Conversations are on disk and
    //    come back through resume_session after the restart.
    const workers = runtime.list();
    for (const w of workers) w.end();
    await Promise.race([
      Promise.all(workers.map((w) => w.exited)),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
    for (const w of workers) if (w.alive) w.kill("SIGTERM");
    db.close();
    if (existsSync(config.daemon.socket_path)) rmSync(config.daemon.socket_path);
    log.info("daemon.shutdown.done", {});
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("daemon.boot.fail", err);
  process.exit(1);
});
