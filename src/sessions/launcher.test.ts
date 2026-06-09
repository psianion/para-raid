import { test, expect } from "bun:test";
import { launchSession } from "./launcher";
import { createFakeTmux } from "../tmux/fake";
import { createEventBus } from "../events/bus";

test("launcher creates tmux session and resolves on SessionStart", async () => {
  const tmux = createFakeTmux();
  const bus = createEventBus();

  const promise = launchSession({
    tmux, bus,
    sessionId: "00000000-0000-4000-8000-000000000001",
    tmuxName: "para-raid-abc",
    cwd: "/tmp/test",
    timeoutMs: 5000,
  });

  setTimeout(() => {
    bus.emit({
      hook_event_name: "SessionStart",
      session_id: "00000000-0000-4000-8000-000000000001",
      cwd: "/tmp/test",
    });
  }, 100);

  await promise;
  expect(tmux.calls[0].method).toBe("newSession");
  expect(tmux.calls[0].args[0]).toBe("para-raid-abc");
  expect(tmux.calls[0].args[1]).toBe("/tmp/test");
  expect(tmux.calls[0].args[2]).toContain("exec env -u ANTHROPIC_API_KEY claude");
  expect(tmux.calls[0].args[2]).toContain("--session-id 00000000-0000-4000-8000-000000000001");
});

test("launcher rejects on timeout", async () => {
  const tmux = createFakeTmux();
  const bus = createEventBus();

  await expect(
    launchSession({
      tmux, bus,
      sessionId: "00000000-0000-4000-8000-000000000002",
      tmuxName: "pr-x",
      cwd: "/tmp",
      timeoutMs: 200,
    })
  ).rejects.toThrow("timeout");
});

test("launcher ignores SessionStart for a different session_id", async () => {
  const tmux = createFakeTmux();
  const bus = createEventBus();

  const promise = launchSession({
    tmux, bus,
    sessionId: "00000000-0000-4000-8000-000000000003",
    tmuxName: "pr-y",
    cwd: "/tmp",
    timeoutMs: 400,
  });

  setTimeout(() => bus.emit({
    hook_event_name: "SessionStart",
    session_id: "wrong-id",
    cwd: "/tmp",
  }), 50);

  await expect(promise).rejects.toThrow("timeout");
});
