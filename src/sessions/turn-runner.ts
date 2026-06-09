import { sendPrompt, type TmuxAdapter } from "../tmux/adapter";
import type { EventBus } from "../events/bus";
import type { HookEvent } from "../types";

export interface TurnJob {
  tmux_session: string;
  session_id: string;
  prompt: string;
}

export interface RunTurnDeps {
  tmux: TmuxAdapter;
  bus: EventBus;
  timeoutMs?: number;
}

export async function runTurn(job: TurnJob, deps: RunTurnDeps): Promise<string> {
  const { tmux, bus, timeoutMs = 60_000 } = deps;
  // sendPrompt pastes via the tmux buffer for multi-line / large prompts so
  // they aren't truncated, and falls back to literal keys for simple text.
  await sendPrompt(tmux, job.tmux_session, job.prompt);

  return new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => {
      unsub();
      reject(new Error(`Stop timeout after ${timeoutMs}ms for session ${job.session_id}`));
    }, timeoutMs);
    const unsub = bus.subscribe((e: HookEvent) => {
      if (e.hook_event_name === "Stop" && e.session_id === job.session_id) {
        clearTimeout(t);
        unsub();
        resolve(e.last_assistant_message ?? "");
      }
    });
  });
}
