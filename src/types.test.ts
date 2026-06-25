import { test, expect } from "bun:test";
import { WEBHOOK_EVENT_TYPES } from "./types";

// Pins the webhook contract to the exact set the daemon emits (verified by
// enumerating every `INSERT INTO webhook_queue` site). Adding/removing an event
// must be a conscious change here, and the helper param types (WebhookEventType)
// make tsc reject any emit site that drifts from this list.
test("webhook contract is exactly the event types the daemon emits", () => {
  expect([...WEBHOOK_EVENT_TYPES].sort()).toEqual([
    "paused",
    "resumed",
    "session_closed",
    "session_dead",
    "session_live",
    "session_open_acknowledged",
    "session_recover_candidate",
    "session_recycled",
    "session_resumed",
    "tool_call",
    "turn_cancelled",
    "turn_failed",
    "turn_replied",
  ]);
});

test("webhook contract no longer lists the never-emitted names", () => {
  const set = new Set<string>(WEBHOOK_EVENT_TYPES);
  for (const dead of ["session_started", "reply"]) expect(set.has(dead)).toBe(false);
});
