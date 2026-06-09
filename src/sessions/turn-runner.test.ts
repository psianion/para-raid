import { test, expect } from "bun:test";
import { runTurn } from "./turn-runner";
import { createEventBus } from "../events/bus";
import { createFakeTmux } from "../tmux/fake";
import type { HookEvent } from "../types";

test("runTurn sends prompt + Enter, then resolves with last_assistant_message", async () => {
  const tmux = createFakeTmux();
  const bus = createEventBus();
  const job = { tmux_session: "para-raid-abc", session_id: "sid-1", prompt: "say hi" };

  const promise = runTurn(job, { tmux, bus, timeoutMs: 1_000 });
  setTimeout(() => {
    const stop: HookEvent = {
      hook_event_name: "Stop",
      session_id: "sid-1",
      tmux_session: "para-raid-abc",
      cwd: "/tmp",
      transcript_path: "/tmp/x",
      last_assistant_message: "hello",
    } as any;
    bus.emit(stop);
  }, 50);

  const reply = await promise;
  expect(reply).toBe("hello");
  expect(tmux.calls.some(c => c.method === "sendKeysLiteral" && c.args[1] === "say hi")).toBe(true);
  expect(tmux.calls.some(c => c.method === "sendEnter")).toBe(true);
});

test("runTurn uses loadBufferAndPaste for multi-line prompts (no truncation)", async () => {
  const tmux = createFakeTmux();
  const bus = createEventBus();
  const job = { tmux_session: "para-raid-ml", session_id: "ml-1", prompt: "line one\nline two" };
  const promise = runTurn(job, { tmux, bus, timeoutMs: 1_000 });
  setTimeout(() => {
    bus.emit({ hook_event_name: "Stop", session_id: "ml-1", last_assistant_message: "ok" } as any);
  }, 25);
  await promise;
  expect(tmux.calls.some(c => c.method === "loadBufferAndPaste" && c.args[1] === "line one\nline two")).toBe(true);
  expect(tmux.calls.some(c => c.method === "sendKeysLiteral")).toBe(false);
  expect(tmux.calls.some(c => c.method === "sendEnter")).toBe(true);
});

test("runTurn rejects on timeout", async () => {
  const tmux = createFakeTmux();
  const bus = createEventBus();
  const job = { tmux_session: "para-raid-x", session_id: "sid-2", prompt: "p" };
  await expect(runTurn(job, { tmux, bus, timeoutMs: 50 })).rejects.toThrow(/timeout/i);
});

test("runTurn ignores Stop events for other sessions", async () => {
  const tmux = createFakeTmux();
  const bus = createEventBus();
  const job = { tmux_session: "para-raid-mine", session_id: "mine", prompt: "p" };
  const promise = runTurn(job, { tmux, bus, timeoutMs: 200 });
  setTimeout(() => {
    bus.emit({ hook_event_name: "Stop", session_id: "other", last_assistant_message: "wrong" } as any);
  }, 25);
  await expect(promise).rejects.toThrow(/timeout/i);
});

test("runTurn unsubscribes after resolve and after timeout (no listener leak)", async () => {
  const tmux = createFakeTmux();
  const bus = createEventBus();
  const baseline = bus.handlerCount();

  // resolve path: schedule the Stop emit, then await runTurn to completion;
  // after settle, the handler count must be back to baseline.
  const job1 = { tmux_session: "para-raid-r", session_id: "r1", prompt: "p" };
  const p1 = runTurn(job1, { tmux, bus, timeoutMs: 1_000 });
  setTimeout(() => {
    bus.emit({ hook_event_name: "Stop", session_id: "r1", last_assistant_message: "done" } as any);
  }, 25);
  const reply = await p1;
  expect(reply).toBe("done");
  expect(bus.handlerCount()).toBe(baseline);

  // timeout path
  const job2 = { tmux_session: "para-raid-t", session_id: "t1", prompt: "p" };
  const p2 = runTurn(job2, { tmux, bus, timeoutMs: 30 });
  await expect(p2).rejects.toThrow(/timeout/i);
  expect(bus.handlerCount()).toBe(baseline);

  // Stale Stop emits for the now-unsubscribed turns must not trigger anything;
  // a fresh subscriber proves the bus still works and that ONLY it sees emits.
  let stray = 0;
  const off = bus.subscribe(() => { stray++; });
  bus.emit({ hook_event_name: "Stop", session_id: "r1", last_assistant_message: "stale" } as any);
  bus.emit({ hook_event_name: "Stop", session_id: "t1", last_assistant_message: "stale" } as any);
  off();
  expect(stray).toBe(2);
  expect(bus.handlerCount()).toBe(baseline);
});
