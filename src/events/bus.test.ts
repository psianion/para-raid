import { test, expect } from "bun:test";
import { createEventBus } from "./bus";
import type { WorkerEvent } from "../worker/runtime";

test("EventBus delivers events to subscribers", () => {
  const bus = createEventBus();
  const received: WorkerEvent[] = [];
  bus.subscribe((e) => received.push(e));

  bus.emit({ type: "result", session_id: "s1", subtype: "success", is_error: false, result: "hi" });

  expect(received).toHaveLength(1);
  expect(received[0].session_id).toBe("s1");
});

test("EventBus onExit fires only for the named session, and unsubscribe works", () => {
  const bus = createEventBus();
  let hits = 0;
  const off = bus.onExit("s1", () => { hits++; });
  bus.emit({ type: "exit", session_id: "other", code: 0, signal: null });
  bus.emit({ type: "init", session_id: "s1" });
  bus.emit({ type: "exit", session_id: "s1", code: 0, signal: null });
  expect(hits).toBe(1);
  off();
  bus.emit({ type: "exit", session_id: "s1", code: 0, signal: null });
  expect(hits).toBe(1);
  expect(bus.handlerCount()).toBe(0);
});

test("EventBus tolerates a handler that unsubscribes itself mid-emit", () => {
  const bus = createEventBus();
  const seen: string[] = [];
  const off = bus.subscribe((e) => { seen.push("a:" + e.session_id); off(); });
  bus.subscribe((e) => seen.push("b:" + e.session_id));
  bus.emit({ type: "init", session_id: "x" });
  bus.emit({ type: "init", session_id: "y" });
  expect(seen).toEqual(["a:x", "b:x", "b:y"]);
});
