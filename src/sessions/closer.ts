// src/sessions/closer.ts — stop a worker gracefully, then forcibly.
import { rmSync } from "fs";
import type { WorkerRuntime } from "../worker/runtime";

export interface CloseOpts {
  runtime: WorkerRuntime;
  sessionId: string;
  workdir: string | null;       // pass null for recycler (skip cleanup)
  /** How long to wait after closing stdin before SIGTERM. Default 10s. */
  timeoutMs?: number;
  /** How long to wait after SIGTERM before SIGKILL. Default 3s. */
  killGraceMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Closing stdin tells claude the conversation is over; it finishes any
 * background work it started and exits on its own. That wait is bounded:
 * after `timeoutMs` we SIGTERM (claude exits 143 promptly and runs its
 * SessionEnd hooks), and after `killGraceMs` more we SIGKILL.
 */
export async function closeSession(opts: CloseOpts): Promise<void> {
  const { runtime, sessionId, workdir, timeoutMs = 10_000, killGraceMs = 3_000 } = opts;
  const handle = runtime.get(sessionId);

  if (handle && handle.alive) {
    handle.end();
    if (await raceExit(handle.exited, timeoutMs) === "timeout") {
      handle.kill("SIGTERM");
      if (await raceExit(handle.exited, killGraceMs) === "timeout") {
        handle.kill("SIGKILL");
        await raceExit(handle.exited, 1_000);
      }
    }
  }

  if (workdir !== null) {
    rmSync(workdir, { recursive: true, force: true });
  }
}

async function raceExit(exited: Promise<number | null>, ms: number): Promise<"exited" | "timeout"> {
  return Promise.race([
    exited.then(() => "exited" as const),
    sleep(ms).then(() => "timeout" as const),
  ]);
}
