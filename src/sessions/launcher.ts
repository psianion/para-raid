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
  // 120s: claude's cold boot on modest hardware (WSL2, first model-version
  // check) measured ~46s — 30s was tuned on the VPS and killed healthy
  // launches. A genuinely dead pane just fails slower; the watchdog covers it.
  const { tmux, bus, sessionId, tmuxName, cwd, timeoutMs = 120_000 } = opts;

  return new Promise<void>(async (resolve, reject) => {
    // claude shows an interactive "Bypass Permissions mode" acceptance dialog
    // on EVERY --dangerously-skip-permissions launch (>=2.1.2xx) and does not
    // persist the answer, so the launcher must answer it: watch the pane and
    // select "2. Yes, I accept" when the prompt appears. Config-flag seeding
    // and IS_SANDBOX=1 were both tried and do not suppress it.
    const dialogPoll = setInterval(async () => {
      try {
        const pane = await tmux.capturePaneOutput(tmuxName, 40);
        if (/Yes, I accept/.test(pane)) {
          await tmux.sendKeysLiteral(tmuxName, "2");
          await tmux.sendEnter(tmuxName);
          clearInterval(dialogPoll);
        }
      } catch {
        // pane may not exist yet or already be gone; keep polling until launch settles
      }
    }, 1500);

    const timer = setTimeout(() => {
      clearInterval(dialogPoll);
      reject(new Error(`SessionStart timeout for ${sessionId}`));
    }, timeoutMs);

    bus.subscribe((event) => {
      if (event.hook_event_name === "SessionStart" && event.session_id === sessionId) {
        clearInterval(dialogPoll);
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
      clearInterval(dialogPoll);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
