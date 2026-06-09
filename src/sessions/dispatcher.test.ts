import { test, expect } from "bun:test";
import { createDispatcher } from "./dispatcher";
import { createFakeTmux } from "../tmux/fake";
import type { DispatchJob } from "../types";

const job = (sid: string, tid: string): DispatchJob => ({
  session_id: sid, turn_id: tid, prompt: "p", tmux_session: sid,
});

test("dispatcher respects max_concurrent_turns", async () => {
  const tmux = createFakeTmux();
  let active = 0;
  let max = 0;

  const d = createDispatcher({
    maxConcurrentTurns: 2,
    tmux,
    onDispatch: async () => {
      active++; max = Math.max(max, active);
      await new Promise(r => setTimeout(r, 50));
      active--;
      return "ok";
    },
  });

  await Promise.all([
    d.enqueue(job("s1", "t1")),
    d.enqueue(job("s2", "t2")),
    d.enqueue(job("s3", "t3")),
    d.enqueue(job("s4", "t4")),
  ]);

  expect(max).toBe(2);
  d.stop();
});

test("dispatcher serializes turns within a session (FIFO per session)", async () => {
  const tmux = createFakeTmux();
  const order: string[] = [];

  const d = createDispatcher({
    maxConcurrentTurns: 4,
    tmux,
    onDispatch: async (j) => {
      order.push(`start:${j.turn_id}`);
      await new Promise(r => setTimeout(r, 30));
      order.push(`end:${j.turn_id}`);
      return "ok";
    },
  });

  await Promise.all([
    d.enqueue(job("s1", "t1")),
    d.enqueue(job("s1", "t2")),
    d.enqueue(job("s1", "t3")),
  ]);

  expect(order).toEqual([
    "start:t1", "end:t1",
    "start:t2", "end:t2",
    "start:t3", "end:t3",
  ]);
  d.stop();
});

test("dispatcher returns the onDispatch result", async () => {
  const tmux = createFakeTmux();
  const d = createDispatcher({
    maxConcurrentTurns: 1, tmux,
    onDispatch: async (j) => `reply-for-${j.turn_id}`,
  });
  const r = await d.enqueue(job("s1", "t-x"));
  expect(r).toBe("reply-for-t-x");
  d.stop();
});
