// src/tmux/fake.ts
import type { TmuxAdapter } from "./adapter";

export interface FakeTmuxCall {
  method: string;
  args: unknown[];
}

export function createFakeTmux(): TmuxAdapter & { calls: FakeTmuxCall[]; sessions: Set<string> } {
  const calls: FakeTmuxCall[] = [];
  const sessions = new Set<string>();

  function record(method: string, args: unknown[]) {
    calls.push({ method, args });
  }

  return {
    calls,
    sessions,
    async newSession(name, cwd, command) { record("newSession", [name, cwd, command]); sessions.add(name); },
    async hasSession(name) { record("hasSession", [name]); return sessions.has(name); },
    async sendKeysLiteral(name, text) { record("sendKeysLiteral", [name, text]); },
    async loadBufferAndPaste(name, text) { record("loadBufferAndPaste", [name, text]); },
    async sendEnter(name) { record("sendEnter", [name]); },
    async sendEscape(name) { record("sendEscape", [name]); },
    async sendCtrlC(name) { record("sendCtrlC", [name]); },
    async killSession(name) { record("killSession", [name]); sessions.delete(name); },
    async listPanePid(name) { record("listPanePid", [name]); return sessions.has(name) ? 12345 : null; },
    async capturePaneOutput(name, lines) { record("capturePaneOutput", [name, lines]); return "fake output"; },
  };
}
