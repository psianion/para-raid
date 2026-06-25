#!/usr/bin/env bun
// src/bin/para-raid.ts — Para-RAID command-line client.
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/loader";
import { buildDoctorChecks, runDoctorChecks } from "./doctor";

const VERSION = "0.1.0";
const HELP = `Para-RAID CLI v${VERSION} — drive your own Claude sessions from chat.

Usage: para-raid <command> [args...] [--json]

Setup:
  setup                 configure this box: write config + token + signing secret, install the unit, run checks
  doctor                re-check prerequisites and config

Run:
  up                    start the daemon (systemd --user, or foreground if there's no systemd)
  pause [--reason ...]  stop accepting new turns
  resume                resume after a pause

Health:
  status                daemon mode + session counts
  stats                 detailed metrics
  sessions list         list sessions
  sessions show <id>    show one session
  dead-letters list     undelivered webhooks
  dead-letters ack --event-id <id>

Advanced — your adapter normally drives these over the socket; you rarely type them:
  open-session  --adapter-id X --adapter-ref Y --prompt "..." [--bundle B]
  send-turn     --id <session-id> --prompt "..."
  cancel-turn   --id <session-id>
  close-session --id <session-id>
  recycle-session --id <session-id>
  daemon                run the daemon in the foreground (dev)
  version               print version

Global flags:
  --json            emit raw JSON instead of the human format
  --config PATH     override config path (default: $PARARAID_CONFIG or ~/.config/para-raid/config.toml)
`;

export interface ParsedArgs {
  subcommand: string;
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [subcommand = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = rest[i + 1];
        if (next === undefined || next.startsWith("--")) {
          flags[a.slice(2)] = true;
        } else {
          flags[a.slice(2)] = next;
          i++;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { subcommand, positional, flags };
}

export function formatJson(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [fmt(headers), ...rows.map(fmt)].join("\n");
}

interface ApiResult { status: number; body: any; }

/** Bearer header for the control socket — present only when a token is configured. */
export function authHeader(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
let authToken = "";

async function apiCall(socket: string, method: "GET" | "POST", path: string, body?: any, idempotencyKey?: string, token?: string): Promise<ApiResult> {
  const init: any = {
    method,
    headers: {
      "Content-Type": "application/json",
      // Identity is derived from the bearer token alone — no X-Adapter-Id.
      ...authHeader(token ?? authToken),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    unix: socket,
  };
  let r: Response;
  try {
    r = await fetch(`http://x${path}`, init);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    const code = err?.code ?? "";
    if (
      code === "FailedToOpenSocket" || code === "ECONNREFUSED" || code === "ENOENT" ||
      msg.includes("ECONNREFUSED") || msg.includes("ENOENT") || msg.includes("typo in the url or port")
    ) {
      throw new Error(`cannot reach daemon at ${socket} (is it running? try: systemctl --user status para-raid)`);
    }
    throw err;
  }
  const text = await r.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}

function requireFlag(flags: Record<string, string | true>, name: string): string {
  const v = flags[name];
  if (v === undefined) { console.error(`error: --${name} is required`); process.exit(2); }
  if (v === true) { console.error(`error: --${name} requires a value`); process.exit(2); }
  if (v === "") { console.error(`error: --${name} cannot be empty`); process.exit(2); }
  return v;
}

function printJsonOrFormatted(asJson: boolean, jsonObj: unknown, formatted: string): void {
  console.log(asJson ? formatJson(jsonObj) : formatted);
}

function exitForStatus(s: number): never {
  process.exit(s >= 200 && s < 300 ? 0 : 1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const asJson = !!args.flags.json;
  const configPath =
    (typeof args.flags.config === "string" ? args.flags.config : undefined) ??
    process.env.PARARAID_CONFIG ?? join(homedir(), ".config/para-raid/config.toml");

  if (args.subcommand === "help" || args.subcommand === "--help" || args.subcommand === "-h") {
    console.log(HELP); process.exit(0);
  }
  if (args.subcommand === "version") {
    console.log(asJson ? formatJson({ version: VERSION }) : `para-raid ${VERSION}`);
    process.exit(0);
  }

  if (args.subcommand === "doctor") {
    const result = await runDoctorChecks(buildDoctorChecks(configPath));
    if (asJson) { console.log(formatJson(result)); process.exit(result.allPass ? 0 : 1); }
    for (const c of result.checks) {
      console.log(`  ${c.pass ? "✓" : "✗"} ${c.name.padEnd(30)} ${c.msg}`);
    }
    console.log(result.allPass ? "\nall checks passed" : "\nsome checks failed");
    process.exit(result.allPass ? 0 : 1);
  }

  if (args.subcommand === "daemon") {
    await import("../daemon");
    return;
  }

  if (args.subcommand === "setup") {
    const { runSetup } = await import("./setup");
    process.exit(await runSetup({ repoDir: join(import.meta.dir, "..", "..") }));
  }

  if (args.subcommand === "up") {
    const { runUp } = await import("./setup");
    await runUp({ repoDir: join(import.meta.dir, "..", "..") });
    return;
  }

  const cfg = loadConfig(configPath);
  authToken = cfg.auth.token ?? "";
  const socket = cfg.daemon.socket_path;
  const adapterId = typeof args.flags["adapter-id"] === "string" ? args.flags["adapter-id"] as string : "cli";

  // Session-owning ops authenticate as the named adapter (its per-adapter
  // token); fall back to the admin token when the adapter isn't in config
  // (e.g. local owner driving by hand). Admin ops just use authToken.
  const adapterToken = (id: string): string => cfg.adapters?.[id]?.token ?? authToken;

  const newKey = () => randomUUID();

  switch (args.subcommand) {
    case "status": {
      const r = await apiCall(socket, "GET", "/v1/status");
      printJsonOrFormatted(asJson, r.body,
        `mode=${r.body.mode}  live=${r.body.sessions?.live ?? "?"}  total=${r.body.sessions?.total ?? "?"}`);
      exitForStatus(r.status);
    }
    case "stats": {
      const r = await apiCall(socket, "GET", "/v1/stats");
      printJsonOrFormatted(asJson, r.body, JSON.stringify(r.body, null, 2));
      exitForStatus(r.status);
    }
    case "pause": {
      const reason = typeof args.flags.reason === "string" ? args.flags.reason : "manual";
      const r = await apiCall(socket, "POST", "/v1/pause", { reason }, newKey());
      printJsonOrFormatted(asJson, r.body, `pause: ${r.status}`);
      exitForStatus(r.status);
    }
    case "resume": {
      const r = await apiCall(socket, "POST", "/v1/resume", {}, newKey());
      printJsonOrFormatted(asJson, r.body, `resume: ${r.status}`);
      exitForStatus(r.status);
    }
    case "open-session": {
      const ref = requireFlag(args.flags, "adapter-ref");
      const prompt = requireFlag(args.flags, "prompt");
      const aid = requireFlag(args.flags, "adapter-id");
      const bundle = typeof args.flags.bundle === "string" ? args.flags.bundle : undefined;
      const r = await apiCall(socket, "POST", "/v1/open_session",
        { adapter_ref: ref, prompt, ...(bundle ? { bundle_name: bundle } : {}) },
        newKey(), adapterToken(aid));
      printJsonOrFormatted(asJson, r.body, `open: ${r.status} sid=${r.body.session_id ?? "?"}`);
      exitForStatus(r.status);
    }
    case "close-session": {
      const id = requireFlag(args.flags, "id");
      const r = await apiCall(socket, "POST", "/v1/close_session", { session_id: id }, newKey(), adapterToken(adapterId));
      printJsonOrFormatted(asJson, r.body, `close: ${r.status}`);
      exitForStatus(r.status);
    }
    case "recycle-session": {
      const id = requireFlag(args.flags, "id");
      const r = await apiCall(socket, "POST", "/v1/recycle_session", { session_id: id }, newKey(), adapterToken(adapterId));
      printJsonOrFormatted(asJson, r.body, `recycle: ${r.status}`);
      exitForStatus(r.status);
    }
    case "send-turn": {
      const id = requireFlag(args.flags, "id");
      const prompt = requireFlag(args.flags, "prompt");
      const r = await apiCall(socket, "POST", "/v1/send_turn", { session_id: id, prompt }, newKey(), adapterToken(adapterId));
      printJsonOrFormatted(asJson, r.body, `send-turn: ${r.status} turn_id=${r.body.turn_id ?? "?"}`);
      exitForStatus(r.status);
    }
    case "cancel-turn": {
      const id = requireFlag(args.flags, "id");
      const r = await apiCall(socket, "POST", "/v1/cancel_turn", { session_id: id }, newKey(), adapterToken(adapterId));
      printJsonOrFormatted(asJson, r.body, `cancel: ${r.status}`);
      exitForStatus(r.status);
    }
    case "sessions": {
      const sub = args.positional[0] ?? "list";
      if (sub === "list") {
        const r = await apiCall(socket, "GET", "/v1/sessions");
        const rows = (r.body.sessions ?? []).map((s: any) => [s.id, s.status, s.adapter_id, s.adapter_ref]);
        printJsonOrFormatted(asJson, r.body, formatTable(["id", "status", "adapter", "ref"], rows));
        exitForStatus(r.status);
      }
      if (sub === "show") {
        const id = args.positional[1];
        if (!id) { console.error("error: sessions show <id>"); process.exit(2); }
        const r = await apiCall(socket, "GET", `/v1/sessions/${id}`);
        printJsonOrFormatted(asJson, r.body, JSON.stringify(r.body, null, 2));
        exitForStatus(r.status);
      }
      console.error(`error: unknown sessions subcommand: ${sub}`);
      process.exit(2);
    }
    case "dead-letters": {
      const sub = args.positional[0] ?? "list";
      if (sub === "list") {
        const r = await apiCall(socket, "GET", "/v1/dead_letters");
        const rows = (r.body.dead_letters ?? []).map((d: any) => [String(d.id), d.event_id, d.event_type, d.session_id ?? "", String(d.attempt_count)]);
        printJsonOrFormatted(asJson, r.body, formatTable(["id", "event_id", "event_type", "session_id", "attempts"], rows));
        exitForStatus(r.status);
      }
      if (sub === "ack") {
        const eventId = requireFlag(args.flags, "event-id");
        const r = await apiCall(socket, "POST", "/v1/dead_letters/ack", { event_ids: [eventId] }, newKey());
        printJsonOrFormatted(asJson, r.body, `ack: ${r.status}`);
        exitForStatus(r.status);
      }
      console.error(`error: unknown dead-letters subcommand: ${sub}`);
      process.exit(2);
    }
  }

  console.error(`unknown subcommand: ${args.subcommand}`);
  console.error(HELP);
  process.exit(2);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`para-raid: ${err?.message ?? err}`);
    process.exit(1);
  });
}
