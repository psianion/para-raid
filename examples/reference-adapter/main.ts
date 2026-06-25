/**
 * Runnable smoke demo: drive ONE real session against a live para-raid daemon
 * and print the signed webhooks as they arrive. This is the bridge between the
 * hermetic e2e test and a real deployment — point it at a daemon that launches
 * a real `claude` worker and confirm a real `turn_replied` comes back verified.
 *
 *   PARARAID_SOCKET=/path/api.sock \
 *   PARARAID_ADAPTER_TOKEN=<adapter token> \
 *   PARARAID_SIGNING_SECRET=<hmac secret> \   # omit if signing.mode = none
 *   bun run examples/reference-adapter/main.ts
 *
 * Exits 0 once a turn_replied for the opened session is received, else 1.
 */
import { createReferenceReceiver } from "./receiver";
import { createReferenceClient } from "./client";

const env = process.env;
const socketPath = env.PARARAID_SOCKET;
const token = env.PARARAID_ADAPTER_TOKEN;
if (!socketPath || !token) {
  console.error("set PARARAID_SOCKET and PARARAID_ADAPTER_TOKEN");
  process.exit(2);
}
const secret = env.PARARAID_SIGNING_SECRET || undefined;
const port = Number(env.PARARAID_RECEIVER_PORT ?? 18900);
const adapterRef = env.PARARAID_ADAPTER_REF ?? "smoke";
const prompt = env.PARARAID_PROMPT ?? "Reply with exactly the single word: READY";
const timeoutMs = Number(env.PARARAID_TIMEOUT_MS ?? 120_000);

const receiver = createReferenceReceiver({ secret, port });
console.log(`[receiver] listening at ${receiver.url}${secret ? " (verifying HMAC)" : ""}`);

const client = createReferenceClient({ socketPath, token });
console.log(`[client] open_session adapter_ref=${adapterRef} prompt=${JSON.stringify(prompt)}`);
const open = await client.openSession({ adapter_ref: adapterRef, prompt });
console.log(`[client] open_session -> ${open.status} ${JSON.stringify(open.body)}`);
if (open.status >= 300) {
  receiver.stop();
  process.exit(1);
}
const sid: string = open.body.session_id;

const terminal = new Set(["turn_replied", "turn_failed", "session_dead"]);
let printed = 0;
let outcome = "timeout";
const started = Date.now();
while (Date.now() - started < timeoutMs) {
  printed = flush(printed);
  const done = receiver.events.find((e) => e.session_id === sid && terminal.has(e.event_type));
  if (done) {
    outcome = done.event_type;
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
flush(printed);

const replied = receiver.events.find((e) => e.session_id === sid && e.event_type === "turn_replied");
if (replied) console.log(`[result] reply=${JSON.stringify((replied.body as any).reply)}`);

try {
  const c = await client.closeSession({ session_id: sid });
  console.log(`[client] close_session -> ${c.status}`);
} catch { /* daemon may already be tearing the session down */ }
receiver.stop();
console.log(`[outcome] ${outcome}`);
process.exit(outcome === "turn_replied" ? 0 : 1);

function flush(from: number): number {
  for (; from < receiver.events.length; from++) {
    const e = receiver.events[from];
    const { tool_input, ...rest } = e.body as any; // tool_input can be large
    console.log(`[webhook] ${e.event_type} session=${e.session_id ?? "-"} ${JSON.stringify(tool_input ? { ...rest, tool_input: "…" } : rest)}`);
  }
  return from;
}
