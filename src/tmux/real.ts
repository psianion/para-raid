// src/tmux/real.ts
import type { TmuxAdapter } from "./adapter";

async function run(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

export function createRealTmux(): TmuxAdapter {
  return {
    async newSession(name, cwd, command) {
      await run(["new-session", "-d", "-s", name, "-c", cwd, command]);
    },
    async hasSession(name) {
      const { exitCode } = await run(["has-session", "-t", name]);
      return exitCode === 0;
    },
    async sendKeysLiteral(name, text) {
      await run(["send-keys", "-t", name, "-l", text]);
    },
    async loadBufferAndPaste(name, text) {
      const proc = Bun.spawn(["tmux", "load-buffer", "-"], { stdin: "pipe" });
      proc.stdin.write(text);
      proc.stdin.end();
      await proc.exited;
      await run(["paste-buffer", "-t", name]);
    },
    async sendEnter(name) {
      await run(["send-keys", "-t", name, "Enter"]);
    },
    async sendEscape(name) {
      await run(["send-keys", "-t", name, "Escape"]);
    },
    async sendCtrlC(name) {
      await run(["send-keys", "-t", name, "C-c"]);
    },
    async killSession(name) {
      await run(["kill-session", "-t", name]);
    },
    async listPanePid(name) {
      const { stdout, exitCode } = await run(["list-panes", "-t", name, "-F", "#{pane_pid}"]);
      if (exitCode !== 0) return null;
      const pid = parseInt(stdout.split("\n")[0], 10);
      return isNaN(pid) ? null : pid;
    },
    async capturePaneOutput(name, lines = 100) {
      const { stdout } = await run(["capture-pane", "-t", name, "-p", "-J", `-S`, `-${lines}`]);
      return stdout;
    },
  };
}
