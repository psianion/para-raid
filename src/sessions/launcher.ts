import type { TmuxAdapter } from "../tmux/adapter";
import type { EventBus } from "../events/bus";
import { claudeLaunchCommand } from "../workdir";

export interface LaunchOpts {
  tmux: TmuxAdapter;
  bus: EventBus;
  sessionId: string;          // must be a valid UUID — passed to claude --session-id
  tmuxName: string;
  cwd: string;
  timeoutMs?: number;
}

export function launchSession(opts: LaunchOpts): Promise<void> {
  const { tmux, bus, sessionId, tmuxName, cwd, timeoutMs = 30_000 } = opts;

  return new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`SessionStart timeout for ${sessionId}`)),
      timeoutMs,
    );

    bus.subscribe((event) => {
      if (event.hook_event_name === "SessionStart" && event.session_id === sessionId) {
        clearTimeout(timer);
        resolve();
      }
    });

    const launchCmd = claudeLaunchCommand({
      args: ["--dangerously-skip-permissions", "--session-id", sessionId],
      unsetEnv: ["ANTHROPIC_API_KEY"],
    });

    try {
      await tmux.newSession(tmuxName, cwd, launchCmd);
    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
