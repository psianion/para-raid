import { test, expect } from "bun:test";
import { launchSession } from "./launcher";
import { createFakeRuntime } from "../worker/fake";
import { createEventBus } from "../events/bus";

const SID = "00000000-0000-4000-8000-000000000001";

test("launcher spawns a new worker and resolves once it has stayed alive through the grace window", async () => {
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);

  const t0 = Date.now();
  const handle = await launchSession({ runtime, bus, sessionId: SID, cwd: "/tmp/test", mcpConfigPath: "/tmp/test/.mcp.json", readyGraceMs: 60 });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
  expect(handle.sessionId).toBe(SID);
  expect(handle.alive).toBe(true);
  expect(runtime.spawns).toHaveLength(1);
  expect(runtime.spawns[0]).toEqual({ sessionId: SID, cwd: "/tmp/test", mode: "new", mcpConfigPath: "/tmp/test/.mcp.json" });
});

test("launcher resumes an existing conversation when asked", async () => {
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  await launchSession({ runtime, bus, sessionId: SID, cwd: "/tmp/test", resume: true, readyGraceMs: 10 });
  expect(runtime.spawns[0].mode).toBe("resume");
});

test("launcher rejects when the worker exits inside the grace window", async () => {
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  runtime.exitOnSpawn = 1;
  await expect(
    launchSession({ runtime, bus, sessionId: SID, cwd: "/tmp", readyGraceMs: 500 })
  ).rejects.toThrow(/exited before ready/);
});

test("launcher rejects when spawn itself throws", async () => {
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  runtime.failNextSpawn = new Error("claude: command not found");
  await expect(
    launchSession({ runtime, bus, sessionId: SID, cwd: "/tmp", readyGraceMs: 10 })
  ).rejects.toThrow(/command not found/);
});

test("launcher ignores an exit for a different session and unsubscribes after settle", async () => {
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  const baseline = bus.handlerCount();
  const p = launchSession({ runtime, bus, sessionId: SID, cwd: "/tmp", readyGraceMs: 80 });
  setTimeout(() => bus.emit({ type: "exit", session_id: "00000000-0000-4000-8000-00000000ffff", code: 1, signal: null }), 10);
  await p;
  // The fake worker registers its own turnText subscriber; everything the
  // launcher added is gone.
  expect(bus.handlerCount()).toBe(baseline + 1);
});
