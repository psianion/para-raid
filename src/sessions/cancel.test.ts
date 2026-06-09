import { test, expect } from "bun:test";
import { cancelTurn } from "./cancel";
import { createFakeTmux } from "../tmux/fake";
import { createEventBus } from "../events/bus";

test("cancel returns cancelled=true when Stop arrives after Escape", async () => {
  const tmux = createFakeTmux();
  tmux.sessions.add("pr-c1");
  const bus = createEventBus();

  const p = cancelTurn({
    tmux, bus,
    sessionId: "00000000-0000-4000-8000-00000000dddd",
    tmuxName: "pr-c1",
    transcriptPath: "/tmp/pararaid-w34-cancel/missing.jsonl",
    escapeWaitMs: 200,
    ctrlcWaitMs: 200,
  });

  setTimeout(() => bus.emit({
    hook_event_name: "Stop",
    session_id: "00000000-0000-4000-8000-00000000dddd",
    cwd: "/tmp",
  }), 50);

  const r = await p;
  expect(r.cancelled).toBe(true);
  expect(r.escalatedToCtrlC).toBe(false);

  const sentEsc = tmux.calls.some(c => c.method === "sendEscape");
  const sentCtrlC = tmux.calls.some(c => c.method === "sendCtrlC");
  expect(sentEsc).toBe(true);
  expect(sentCtrlC).toBe(false);
});

test("cancel escalates to Ctrl-C when Stop never arrives after Escape", async () => {
  const tmux = createFakeTmux();
  tmux.sessions.add("pr-c2");
  const bus = createEventBus();

  const p = cancelTurn({
    tmux, bus,
    sessionId: "00000000-0000-4000-8000-00000000eeee",
    tmuxName: "pr-c2",
    transcriptPath: "/tmp/pararaid-w34-cancel/missing.jsonl",
    escapeWaitMs: 100,
    ctrlcWaitMs: 100,
  });

  const r = await p;
  expect(r.cancelled).toBe(false);
  expect(r.escalatedToCtrlC).toBe(true);
});
