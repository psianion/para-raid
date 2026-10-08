// src/sessions/launcher.ts — spawn a worker and make sure it came up.
import type { EventBus } from "../events/bus";
import type { WorkerHandle, WorkerRuntime } from "../worker/runtime";

export interface LaunchOpts {
  runtime: WorkerRuntime;
  bus: EventBus;
  sessionId: string;          // must be a valid UUID — becomes claude's session id
  cwd: string;
  /** Continue an existing conversation (`claude --resume`) instead of starting one. */
  resume?: boolean;
  mcpConfigPath?: string;
  /** How long to watch for an early exit before declaring the worker up. */
  readyGraceMs?: number;
}

/**
 * Starts the worker and resolves once it has stayed alive for `readyGraceMs`.
 *
 * There is no readiness event to wait for: in stream-json mode claude emits
 * its `init` at the start of every turn, i.e. only after the first user
 * message arrives, so a launcher that waited for it would wait forever. A
 * launch that is going to fail outright — bad flags, binary missing, a
 * `--resume` id with no transcript, not logged in — exits within moments,
 * which is what the grace window catches; anything later surfaces as the
 * first turn's failure.
 */
/** Process-wide default for `readyGraceMs`; tests shrink it. */
export const launchDefaults = { readyGraceMs: 1_500 };

export function launchSession(opts: LaunchOpts): Promise<WorkerHandle> {
  const { runtime, bus, sessionId, cwd, resume = false, mcpConfigPath, readyGraceMs = launchDefaults.readyGraceMs } = opts;

  return new Promise<WorkerHandle>((resolve, reject) => {
    let handle: WorkerHandle | null = null;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsub();
      fn();
    };

    const timer = setTimeout(() => finish(() => resolve(handle!)), readyGraceMs);

    // Subscribe BEFORE spawning: the fake runtime (and a real claude that
    // dies on a bad flag) can exit almost immediately.
    const unsub = bus.subscribe((ev) => {
      if (ev.session_id !== sessionId) return;
      if (ev.type === "exit") finish(() => reject(new Error(`worker exited before ready (code ${ev.code}) for ${sessionId}`)));
    });

    try {
      handle = runtime.spawn({ sessionId, cwd, mode: resume ? "resume" : "new", mcpConfigPath });
      if (!handle.alive) finish(() => reject(new Error(`worker exited before ready for ${sessionId}`)));
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}
