import { test, expect } from "bun:test";
import { recycleSession } from "./recycler";
import { createFakeTmux } from "../tmux/fake";
import { createEventBus } from "../events/bus";

test("recycler returns a new session_id and re-launches in same tmux", async () => {
  const tmux = createFakeTmux();
  tmux.sessions.add("para-raid-rcy");
  const bus = createEventBus();

  const p = recycleSession({
    tmux, bus,
    oldSessionId: "00000000-0000-4000-8000-00000000cccc",
    tmuxName: "para-raid-rcy",
    cwd: "/tmp/pararaid-w34-recycler/wd",
    timeoutMs: 1000,
  });

  setTimeout(() => bus.emit({
    hook_event_name: "SessionEnd",
    session_id: "00000000-0000-4000-8000-00000000cccc",
    cwd: "/tmp",
  }), 50);

  const tHandle = setInterval(() => {
    const launchCalls = tmux.calls.filter(c => c.method === "newSession");
    if (launchCalls.length === 0) return;
    clearInterval(tHandle);
    const cmd = launchCalls[0].args[2] as string;
    const m = cmd.match(/--session-id ([\w-]+)/);
    if (m) {
      bus.emit({ hook_event_name: "SessionStart", session_id: m[1], cwd: "/tmp" });
    }
  }, 20);

  const newId = await p;
  expect(newId).not.toBe("00000000-0000-4000-8000-00000000cccc");
  expect(newId).toMatch(/^[0-9a-f-]{36}$/i);
});
