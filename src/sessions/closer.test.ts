import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { closeSession } from "./closer";
import { createFakeRuntime } from "../worker/fake";
import { createEventBus } from "../events/bus";

const SID = "00000000-0000-4000-8000-00000000aaaa";
const WD = "/tmp/pararaid-closer-test/wd";
afterEach(() => rmSync("/tmp/pararaid-closer-test", { recursive: true, force: true }));

test("closer closes stdin, waits for the worker to exit on its own, and removes the workdir", async () => {
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  runtime.spawn({ sessionId: SID, cwd: WD, mode: "new" });
  mkdirSync(WD, { recursive: true });

  await closeSession({ runtime, sessionId: SID, workdir: WD, timeoutMs: 1000 });

  const w = runtime.workers.get(SID)!;
  expect(w.ended).toBe(true);
  expect(w.killed).toEqual([]);
  expect(w.alive).toBe(false);
  expect(existsSync(WD)).toBe(false);
});

test("closer escalates to SIGTERM when the worker ignores stdin close", async () => {
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  runtime.exitOnEnd = false;
  runtime.spawn({ sessionId: SID, cwd: WD, mode: "new" });

  await closeSession({ runtime, sessionId: SID, workdir: null, timeoutMs: 100, killGraceMs: 100 });

  const w = runtime.workers.get(SID)!;
  expect(w.ended).toBe(true);
  expect(w.killed).toEqual(["SIGTERM"]);
  expect(w.alive).toBe(false);
});

test("closer is a no-op for a session with no worker (still cleans the workdir)", async () => {
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  mkdirSync(WD, { recursive: true });
  await closeSession({ runtime, sessionId: SID, workdir: WD, timeoutMs: 100 });
  expect(existsSync(WD)).toBe(false);
});
