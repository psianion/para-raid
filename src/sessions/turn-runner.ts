// src/sessions/turn-runner.ts — send one prompt and wait for its result.
import type { EventBus } from "../events/bus";
import type { WorkerRuntime } from "../worker/runtime";

export interface TurnJob {
  session_id: string;
  prompt: string;
}

export interface RunTurnDeps {
  runtime: WorkerRuntime;
  bus: EventBus;
  timeoutMs?: number;
}

/**
 * Resolves with the reply text when claude emits the turn's `result` event.
 * Falls back to the accumulated assistant text when `result` is empty (claude
 * leaves it empty for some short replies and after an interrupt).
 *
 * Rejects when: the result is an error (claude reports its message in the
 * text), the worker exits mid-turn, or the turn times out. On timeout the
 * running turn is interrupted so the session stays usable — a queued message
 * would otherwise wait behind the stuck one.
 */
export async function runTurn(job: TurnJob, deps: RunTurnDeps): Promise<string> {
  const { runtime, bus, timeoutMs = 60_000 } = deps;
  const handle = runtime.get(job.session_id);
  if (!handle || !handle.alive) throw new Error(`no live worker for session ${job.session_id}`);

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        try { handle.interrupt(); } catch { /* worker gone; exit path reports */ }
        reject(new Error(`turn timeout after ${timeoutMs}ms for session ${job.session_id}`));
      });
    }, timeoutMs);

    // Subscribe BEFORE sending so a fast result is never missed.
    const unsub = bus.subscribe((ev) => {
      if (ev.session_id !== job.session_id) return;
      if (ev.type === "result") {
        const text = ev.result.length > 0 ? ev.result : handle.turnText;
        if (ev.is_error) finish(() => reject(new Error(`turn failed (${ev.subtype}${ev.terminal_reason ? `, ${ev.terminal_reason}` : ""}): ${text || "no output"}`)));
        else finish(() => resolve(text));
      } else if (ev.type === "exit") {
        finish(() => reject(new Error(`worker exited mid-turn (code ${ev.code}) for session ${job.session_id}`)));
      }
    });

    try {
      handle.send(job.prompt);
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}
