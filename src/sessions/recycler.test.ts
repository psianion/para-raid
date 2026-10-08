import { test, expect, afterEach } from "bun:test";
import { launchDefaults } from "./launcher";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { recycleSession } from "./recycler";
import { createFakeRuntime } from "../worker/fake";
import { createEventBus } from "../events/bus";

const OLD = "00000000-0000-4000-8000-00000000cccc";
launchDefaults.readyGraceMs = 30; // fake workers: no early-exit watch needed
const WD = "/tmp/pararaid-recycler-test/wd";
afterEach(() => rmSync("/tmp/pararaid-recycler-test", { recursive: true, force: true }));

test("recycler closes the old worker and launches a fresh conversation in the same workdir", async () => {
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  runtime.spawn({ sessionId: OLD, cwd: WD, mode: "new" });
  mkdirSync(WD, { recursive: true });
  writeFileSync(`${WD}/.mcp.json`, "{}");

  const p = recycleSession({ runtime, bus, oldSessionId: OLD, cwd: WD, timeoutMs: 1000 });


  const newId = await p;
  expect(newId).not.toBe(OLD);
  expect(newId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(runtime.workers.get(OLD)!.alive).toBe(false);
  const fresh = runtime.spawns.find((s) => s.sessionId === newId)!;
  expect(fresh.cwd).toBe(WD);
  expect(fresh.mode).toBe("new");
  expect(fresh.mcpConfigPath).toBe(join(WD, ".mcp.json"));
});
