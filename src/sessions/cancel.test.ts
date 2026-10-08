import { test, expect } from "bun:test";
import { cancelTurn } from "./cancel";
import { createFakeRuntime } from "../worker/fake";
import { createEventBus } from "../events/bus";

const SID = "00000000-0000-4000-8000-00000000dddd";

test("cancel sends an interrupt and reports cancelled once the aborted result lands", async () => {
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  runtime.spawn({ sessionId: SID, cwd: "/tmp", mode: "new" });
  runtime.emitAssistant(SID, "half an answer");

  const p = cancelTurn({ runtime, bus, sessionId: SID, waitMs: 200, signalWaitMs: 200 });
  setTimeout(() => runtime.emitResult(SID, "", { subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" }), 30);

  const r = await p;
  expect(r.cancelled).toBe(true);
  expect(r.escalatedToSignal).toBe(false);
  expect(r.partialText).toBe("half an answer");
  const w = runtime.workers.get(SID)!;
  expect(w.interrupts).toBe(1);
  expect(w.killed).toEqual([]);
});

test("cancel escalates to SIGINT when no result follows the interrupt", async () => {
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  runtime.spawn({ sessionId: SID, cwd: "/tmp", mode: "new" });

  const r = await cancelTurn({ runtime, bus, sessionId: SID, waitMs: 50, signalWaitMs: 50 });
  expect(r.cancelled).toBe(false);
  expect(r.escalatedToSignal).toBe(true);
  expect(r.partialText).toBeNull();
  expect(runtime.workers.get(SID)!.killed).toEqual(["SIGINT"]);
});

test("cancel on a session without a worker is a no-op", async () => {
  const bus = createEventBus();
  const runtime = createFakeRuntime(bus);
  const r = await cancelTurn({ runtime, bus, sessionId: SID, waitMs: 10 });
  expect(r).toEqual({ cancelled: false, escalatedToSignal: false, partialText: null });
});
