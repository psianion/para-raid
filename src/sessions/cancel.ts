// src/sessions/cancel.ts — interrupt the running turn of a session.
import type { EventBus } from "../events/bus";
import type { WorkerRuntime } from "../worker/runtime";

export interface CancelOpts {
  runtime: WorkerRuntime;
  bus: EventBus;
  sessionId: string;
  /** Wait for claude to acknowledge the interrupt with a result. Default 5s. */
  waitMs?: number;
  /** After escalating to SIGINT, wait this long for a result. Default 3s. */
  signalWaitMs?: number;
}

export interface CancelResult {
  cancelled: boolean;            // true iff a result event closed the turn
  escalatedToSignal: boolean;    // true if the interrupt request alone wasn't enough
  partialText: string | null;    // assistant text produced before the cut
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends a `control_request` interrupt; claude ends the turn with a result
 * whose `terminal_reason` is `aborted_streaming`, and the session keeps
 * accepting turns. If no result arrives in time we escalate to SIGINT, which
 * claude also treats as "end the turn".
 */
export async function cancelTurn(opts: CancelOpts): Promise<CancelResult> {
  const { runtime, bus, sessionId, waitMs = 5_000, signalWaitMs = 3_000 } = opts;
  const handle = runtime.get(sessionId);
  if (!handle || !handle.alive) {
    return { cancelled: false, escalatedToSignal: false, partialText: null };
  }

  let resultSeen = false;
  let resolveSeen!: () => void;
  const seen = new Promise<void>((r) => { resolveSeen = r; });
  const unsub = bus.subscribe((ev) => {
    if (ev.session_id !== sessionId) return;
    if (ev.type === "result" || ev.type === "exit") { resultSeen = true; resolveSeen(); }
  });

  try {
    try { handle.interrupt(); } catch { /* stdin closed; fall through to signal */ }
    await Promise.race([seen, sleep(waitMs)]);

    let escalated = false;
    if (!resultSeen) {
      escalated = true;
      handle.kill("SIGINT");
      await Promise.race([seen, sleep(signalWaitMs)]);
    }

    const partial = handle.turnText;
    return {
      cancelled: resultSeen,
      escalatedToSignal: escalated,
      partialText: partial.length > 0 ? partial : null,
    };
  } finally {
    unsub();
  }
}
