import { test, expect } from "bun:test";
import { createEventBus } from "./bus";
import type { HookEvent } from "../types";

test("EventBus delivers events to subscribers", () => {
  const bus = createEventBus();
  const received: HookEvent[] = [];
  bus.subscribe((e) => received.push(e));

  const event: HookEvent = { hook_event_name: "Stop", session_id: "s1", cwd: "/tmp" };
  bus.emit(event);

  expect(received).toHaveLength(1);
  expect(received[0].session_id).toBe("s1");
});
