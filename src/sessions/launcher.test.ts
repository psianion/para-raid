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
  expect(tmux.calls[0].args[2]).toContain("exec env -u ANTHROPIC_API_KEY IS_SANDBOX=1 claude");
  expect(tmux.calls[0].args[2]).toContain("--session-id 00000000-0000-4000-8000-000000000001");
});

test("launcher answers the bypass-permissions dialog when the pane shows it", async () => {
  const tmux = createFakeTmux();
  const bus = createEventBus();
  tmux.paneOutput = "WARNING: Claude Code running in Bypass Permissions mode\n 1. No, exit\n 2. Yes, I accept\nEnter to confirm";

  const promise = launchSession({
    tmux, bus,
    sessionId: "00000000-0000-4000-8000-000000000002",
    tmuxName: "para-raid-dlg",
    cwd: "/tmp/test",
    timeoutMs: 6000,
  });

  // Poll interval is 1.5s — wait for two ticks, then confirm the accept keys.
  await new Promise((r) => setTimeout(r, 3400));
  const methods = tmux.calls.map((c) => c.method);
  expect(methods).toContain("capturePaneOutput");
  const acceptIdx = tmux.calls.findIndex((c) => c.method === "sendKeysLiteral" && c.args[1] === "2");
  expect(acceptIdx).toBeGreaterThan(-1);
  expect(tmux.calls.slice(acceptIdx + 1).some((c) => c.method === "sendEnter")).toBe(true);
  // Accept fires exactly once even though the poll saw the dialog twice.
  expect(tmux.calls.filter((c) => c.method === "sendKeysLiteral" && c.args[1] === "2")).toHaveLength(1);

  bus.emit({
    hook_event_name: "SessionStart",
    session_id: "00000000-0000-4000-8000-000000000002",
    cwd: "/tmp/test",
  });
  await promise;
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
