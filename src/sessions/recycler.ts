// src/sessions/recycler.ts — replace a session's worker with a fresh conversation.
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import type { EventBus } from "../events/bus";
import type { WorkerRuntime } from "../worker/runtime";
import { closeSession } from "./closer";
import { launchSession } from "./launcher";

export interface RecycleOpts {
  runtime: WorkerRuntime;
  bus: EventBus;
  oldSessionId: string;
  cwd: string;
  /** Close timeout for the old worker. Default 10s. */
  timeoutMs?: number;
}

/**
 * Closes the existing worker (keeping the workdir), then launches a new
 * conversation in the same workdir under a fresh UUID. The rendered
 * `.mcp.json`, if any, is reused. Returns the new session_id.
 *
 * No launch timeout override: the launcher default (120s) governs — a cold
 * relaunch takes as long as a cold launch.
 */
export async function recycleSession(opts: RecycleOpts): Promise<string> {
  const { runtime, bus, oldSessionId, cwd, timeoutMs = 10_000 } = opts;

  await closeSession({ runtime, sessionId: oldSessionId, workdir: null, timeoutMs });

  const newId = randomUUID();
  const mcp = join(cwd, ".mcp.json");
  await launchSession({
    runtime, bus,
    sessionId: newId,
    cwd,
    mcpConfigPath: existsSync(mcp) ? mcp : undefined,
  });
  return newId;
}
