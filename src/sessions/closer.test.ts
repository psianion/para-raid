import { test, expect } from "bun:test";
import { closeSession } from "./closer";
import { createFakeTmux } from "../tmux/fake";
import { createEventBus } from "../events/bus";

test("closer sends /exit then resolves on SessionEnd before timeout", async () => {
  const tmux = createFakeTmux();
  tmux.sessions.add("para-raid-x");
  const bus = createEventBus();

  const p = closeSession({
    tmux, bus,
    sessionId: "00000000-0000-4000-8000-00000000aaaa",
    tmuxName: "para-raid-x",
    workdir: "/tmp/pararaid-w34-closer/wd",
    timeoutMs: 1000,
  });

  setTimeout(() => bus.emit({
    hook_event_name: "SessionEnd",
    session_id: "00000000-0000-4000-8000-00000000aaaa",
    cwd: "/tmp",
  }), 50);

  await p;
  const sentExit = tmux.calls.some(c => c.method === "sendKeysLiteral" && c.args[1] === "/exit");
  expect(sentExit).toBe(true);
  const killed = tmux.calls.some(c => c.method === "killSession");
  expect(killed).toBe(false);
});

test("closer escalates to Ctrl-C and kill-session if SessionEnd never arrives", async () => {
  const tmux = createFakeTmux();
  tmux.sessions.add("para-raid-y");
  const bus = createEventBus();

  await closeSession({
    tmux, bus,
    sessionId: "00000000-0000-4000-8000-00000000bbbb",
    tmuxName: "para-raid-y",
    workdir: "/tmp/pararaid-w34-closer/wd2",
    timeoutMs: 200,
  });

  const sentCtrlC = tmux.calls.filter(c => c.method === "sendCtrlC").length;
  const killed = tmux.calls.some(c => c.method === "killSession");
  expect(sentCtrlC).toBeGreaterThanOrEqual(2);
  expect(killed).toBe(true);
});
