import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildClaudeArgs, buildSpawnCommand, createClaudeRuntime } from "./claude";
import { createEventBus } from "../events/bus";
import type { WorkerEvent } from "./runtime";

const SID = "22222222-2222-4222-8222-222222222222";
const NOOP = { info() {}, warn() {}, error() {} } as any;

test("buildClaudeArgs drives headless stream-json under the session id", () => {
  expect(buildClaudeArgs({ sessionId: SID, cwd: "/w", mode: "new" })).toEqual([
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--dangerously-skip-permissions", "--session-id", SID,
  ]);
});

test("buildClaudeArgs resumes, passes the MCP config, model and extra args", () => {
  const args = buildClaudeArgs({ sessionId: SID, cwd: "/w", mode: "resume", mcpConfigPath: "/w/.mcp.json", model: "opus", extraArgs: ["--effort", "high"] });
  expect(args).toContain("--resume");
  expect(args).not.toContain("--session-id");
  expect(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2)).toEqual(["--resume", SID]);
  expect(args.slice(args.indexOf("--mcp-config"), args.indexOf("--mcp-config") + 2)).toEqual(["--mcp-config", "/w/.mcp.json"]);
  expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "opus"]);
  expect(args.slice(-2)).toEqual(["--effort", "high"]);
  // Never --bare: it skips the subscription login and would need an API key.
  expect(args).not.toContain("--bare");
});

test("buildSpawnCommand execs claude directly without env_setup, via bash with it", () => {
  expect(buildSpawnCommand(["-p", "x"])).toEqual(["claude", "-p", "x"]);
  expect(buildSpawnCommand(["-p", "x"], "   ")).toEqual(["claude", "-p", "x"]);
  const viaBash = buildSpawnCommand(["-p", "it's"], "source ~/.nvm/nvm.sh");
  expect(viaBash.slice(0, 2)).toEqual(["bash", "-c"]);
  expect(viaBash[2]).toBe("source ~/.nvm/nvm.sh && exec claude '-p' 'it'\\''s'");
});

// Drives the real runtime against a stand-in "claude" written in bash, so the
// pipe plumbing (line framing, event parsing, turnText, end/exit) is exercised
// without spending a real turn. Linux/WSL only: the deploy target.
const posixOnly = test.skipIf(process.platform === "win32");

posixOnly("runtime streams events from the child and tracks its lifecycle", async () => {
  const bus = createEventBus();
  const events: WorkerEvent[] = [];
  bus.subscribe((e) => events.push(e));

  // A fake `claude` on PATH: prints init, then for each stdin line prints an
  // assistant message and a result, and exits on EOF. Reached through
  // env_setup exactly like an nvm-installed binary would be.
  const binDir = mkdtempSync(join(tmpdir(), "para-raid-fake-claude-"));
  writeFileSync(join(binDir, "claude"), `#!/usr/bin/env bash
echo '{"type":"system","subtype":"init","session_id":"${SID}"}'
while IFS= read -r line; do
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"echo: "},{"type":"text","text":"ok"}]}}'
  echo '{"type":"result","subtype":"success","is_error":false,"result":"echo: ok","num_turns":1}'
done
`, { mode: 0o755 });
  const runtime = createClaudeRuntime({ bus, logger: NOOP, envSetup: `export PATH="${binDir}:$PATH"` });
  const h = runtime.spawn({ sessionId: SID, cwd: "/tmp", mode: "new" });
  expect(h.alive).toBe(true);
  expect(runtime.get(SID)).toBe(h);
  expect(runtime.list()).toEqual([h]);

  await waitFor(() => events.some((e) => e.type === "init"));
  h.send("hello");
  await waitFor(() => events.some((e) => e.type === "result"));
  expect(h.turnText).toBe("echo: ok");

  h.end();
  const code = await h.exited;
  expect(code).toBe(0);
  expect(h.alive).toBe(false);
  expect(h.pid).toBeNull();
  expect(runtime.list()).toEqual([]);
  expect(events.at(-1)?.type).toBe("exit");
  expect(() => h.send("late")).toThrow(/not accepting input/);
  rmSync(binDir, { recursive: true, force: true });
});

async function waitFor(fn: () => boolean, ms = 5_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timeout");
}
