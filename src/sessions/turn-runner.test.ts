import { test, expect } from "bun:test";
import { runTurn } from "./turn-runner";
import { createEventBus } from "../events/bus";
import { createFakeRuntime } from "../worker/fake";

function ready(sid: string) {
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  runtime.spawn({ sessionId: sid, cwd: "/tmp", mode: "new" });
  return { bus, runtime };
}

test("runTurn sends the prompt and resolves with the result text", async () => {
  const { bus, runtime } = ready("sid-1");
  const promise = runTurn({ session_id: "sid-1", prompt: "say hi" }, { runtime, bus, timeoutMs: 1_000 });
  setTimeout(() => runtime.emitResult("sid-1", "hello"), 20);
  expect(await promise).toBe("hello");
  expect(runtime.workers.get("sid-1")!.sent).toEqual(["say hi"]);
});

test("runTurn falls back to accumulated assistant text when result is empty", async () => {
  const { bus, runtime } = ready("sid-2");
  const promise = runTurn({ session_id: "sid-2", prompt: "p" }, { runtime, bus, timeoutMs: 1_000 });
  setTimeout(() => {
    runtime.emitAssistant("sid-2", "part one. ");
    runtime.emitAssistant("sid-2", "part two.");
    runtime.emitResult("sid-2", "");
  }, 20);
  expect(await promise).toBe("part one. part two.");
});

test("runTurn rejects with claude's message on an error result", async () => {
  const { bus, runtime } = ready("sid-3");
  const promise = runTurn({ session_id: "sid-3", prompt: "p" }, { runtime, bus, timeoutMs: 1_000 });
  setTimeout(() => runtime.emitResult("sid-3", "Rate limited", { subtype: "error_during_execution", is_error: true }), 20);
  await expect(promise).rejects.toThrow(/error_during_execution.*Rate limited/);
});

test("runTurn rejects when the worker exits mid-turn", async () => {
  const { bus, runtime } = ready("sid-4");
  const promise = runTurn({ session_id: "sid-4", prompt: "p" }, { runtime, bus, timeoutMs: 1_000 });
  setTimeout(() => runtime.emitExit("sid-4", 137), 20);
  await expect(promise).rejects.toThrow(/exited mid-turn/);
});

test("runTurn rejects on timeout and interrupts the stuck turn", async () => {
  const { bus, runtime } = ready("sid-5");
  await expect(runTurn({ session_id: "sid-5", prompt: "p" }, { runtime, bus, timeoutMs: 50 })).rejects.toThrow(/timeout/i);
  expect(runtime.workers.get("sid-5")!.interrupts).toBe(1);
});

test("runTurn rejects immediately when the session has no live worker", async () => {
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  await expect(runTurn({ session_id: "nope", prompt: "p" }, { runtime, bus, timeoutMs: 50 })).rejects.toThrow(/no live worker/);
});

test("runTurn ignores results for other sessions", async () => {
  const { bus, runtime } = ready("mine");
  const promise = runTurn({ session_id: "mine", prompt: "p" }, { runtime, bus, timeoutMs: 200 });
  setTimeout(() => runtime.emitResult("other", "wrong"), 25);
  await expect(promise).rejects.toThrow(/timeout/i);
});

test("runTurn unsubscribes after resolve and after timeout (no listener leak)", async () => {
  const { bus, runtime } = ready("r1");
  const baseline = bus.handlerCount();

  const p1 = runTurn({ session_id: "r1", prompt: "p" }, { runtime, bus, timeoutMs: 1_000 });
  setTimeout(() => runtime.emitResult("r1", "done"), 25);
  expect(await p1).toBe("done");
  expect(bus.handlerCount()).toBe(baseline);

  const p2 = runTurn({ session_id: "r1", prompt: "p" }, { runtime, bus, timeoutMs: 30 });
  await expect(p2).rejects.toThrow(/timeout/i);
  expect(bus.handlerCount()).toBe(baseline);

  let stray = 0;
  const off = bus.subscribe(() => { stray++; });
  runtime.emitResult("r1", "stale");
  off();
  expect(stray).toBe(1);
  expect(bus.handlerCount()).toBe(baseline);
});
