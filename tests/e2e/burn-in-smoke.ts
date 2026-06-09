#!/usr/bin/env bun
// tests/e2e/burn-in-smoke.ts — drives the systemd-managed daemon end-to-end.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/loader";

const args = process.argv.slice(2);
const KEEP = args.includes("--keep-running");
const VERBOSE = args.includes("--verbose");

const configPath = process.env.PARARAID_CONFIG ?? join(homedir(), ".config/para-raid/config.toml");
const cfg = loadConfig(configPath);
const SOCKET = cfg.daemon.socket_path;

interface Webhook { event_type: string; session_id: string; payload: any; ts: number }
const captured: Webhook[] = [];
const webhookPort = 19500 + Math.floor(Math.random() * 100);
const webhookUrl = `http://127.0.0.1:${webhookPort}/hook`;

const webhookServer = Bun.serve({
  port: webhookPort, hostname: "127.0.0.1",
  fetch: async (req) => {
    const body = await req.json() as any;
    captured.push({ event_type: body.event_type, session_id: body.session_id, payload: body, ts: Date.now() });
    if (VERBOSE) console.log(`  [hook] ${body.event_type} sid=${body.session_id}`);
    return new Response("ok");
  },
});

function fail(msg: string): never {
  console.error(`[FAIL] ${msg}`);
  console.error("=== captured webhooks ===");
  for (const c of captured) console.error(`  ${c.event_type} sid=${c.session_id}`);
  process.exit(1);
}

async function api(method: "GET" | "POST", path: string, body?: any, headers?: Record<string,string>) {
  const init: any = {
    method,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    unix: SOCKET,
  };
  const r = await fetch(`http://x${path}`, init);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
}

async function waitFor(predicate: () => boolean, deadlineMs: number, label: string): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 200));
  }
  fail(`timeout: ${label} (deadline ${deadlineMs}ms)`);
}

async function main() {
  console.log(`[OK] driving daemon at ${SOCKET}`);
  const status0 = await api("GET", "/v1/status");
  if (status0.status !== 200) fail(`daemon not reachable: ${status0.status}`);
  console.log(`[OK] daemon ready, mode=${status0.body.mode}`);

  // STEP 1: open
  const ref1 = `burn-in-${Date.now()}`;
  const open = await api("POST", "/v1/open_session",
    { adapter_id: "burn-in", adapter_ref: ref1, prompt: "say hi in one short word", webhook_url: webhookUrl },
    { "Idempotency-Key": randomUUID(), "X-Adapter-Id": "burn-in" });
  if (open.status !== 202) fail(`open expected 202, got ${open.status}: ${JSON.stringify(open.body)}`);
  const sid: string = open.body.session_id;
  console.log(`[OK] open_session ${sid} (status=${open.body.status})`);

  await waitFor(() => captured.some(c => c.event_type === "turn_replied" && c.session_id === sid),
    90_000, "turn_replied");
  const replied = captured.find(c => c.event_type === "turn_replied" && c.session_id === sid);
  console.log(`[OK] reply: "${String(replied!.payload.reply).slice(0, 60)}"`);

  // STEP 2: send a second turn
  const send = await api("POST", "/v1/send_turn",
    { session_id: sid, prompt: "what is 2+2?" },
    { "Idempotency-Key": randomUUID(), "X-Adapter-Id": "burn-in" });
  if (send.status !== 202) fail(`send expected 202, got ${send.status}: ${JSON.stringify(send.body)}`);
  await waitFor(() =>
    captured.filter(c => c.event_type === "turn_replied" && c.session_id === sid).length >= 2,
    90_000, "second turn_replied");
  console.log(`[OK] second turn replied`);

  if (KEEP) {
    console.log(`[KEEP] session ${sid} left running for burn-in. Ctrl+C to stop.`);
    console.log(`        watch with: para-raid sessions show ${sid}`);
    setInterval(() => {
      const elapsed = captured.length > 0 ? Math.round((Date.now() - captured[0].ts)/1000) : 0;
      console.log(`[idle] webhooks=${captured.length} elapsed=${elapsed}s`);
    }, 60_000);
    return;
  }

  // STEP 3: close
  const close = await api("POST", "/v1/close_session",
    { session_id: sid }, { "Idempotency-Key": randomUUID(), "X-Adapter-Id": "burn-in" });
  if (close.status !== 200) fail(`close expected 200, got ${close.status}: ${JSON.stringify(close.body)}`);
  await waitFor(() => captured.some(c => c.event_type === "session_closed" && c.session_id === sid),
    30_000, "session_closed");
  console.log(`[OK] session_closed`);

  webhookServer.stop();
  console.log("\n[PASS] Wave 8 E2E burn-in smoke green.");
  process.exit(0);
}

main().catch((err) => fail(`unhandled: ${err?.stack ?? err}`));
