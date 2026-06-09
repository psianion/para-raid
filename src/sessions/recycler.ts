import { randomUUID } from "crypto";
import type { TmuxAdapter } from "../tmux/adapter";
import type { EventBus } from "../events/bus";
import { closeSession } from "./closer";
import { launchSession } from "./launcher";
import { writeClaudeSettings } from "../workdir";

export interface RecycleOpts {
  tmux: TmuxAdapter;
  bus: EventBus;
  oldSessionId: string;
  tmuxName: string;
  cwd: string;
  timeoutMs?: number;
  /**
   * If provided, recycleSession rewrites `<cwd>/.claude/settings.json` with
   * the new session id before relaunching, so hook events from the recycled
   * claude are tagged with the new id. Without this, hooks would still emit
   * the OLD para-raid id (the workdir's settings.json was written at first
   * launch). Daemon callers should always pass this.
   */
  hookEventsPath?: string;
}

/**
 * Closes the existing claude (no workdir cleanup), generates a fresh UUID,
 * then launches a new claude in the same tmux pane reusing the workdir.
 * Returns the new session_id.
 *
 * tmux session reaping lags a beat behind the SessionEnd hook, so we
 * defensively kill any leftover pane before relaunch (avoids "duplicate
 * session" from `tmux new-session`).
 */
export async function recycleSession(opts: RecycleOpts): Promise<string> {
  const { tmux, bus, oldSessionId, tmuxName, cwd, timeoutMs = 10_000, hookEventsPath } = opts;

  await closeSession({
    tmux, bus,
    sessionId: oldSessionId,
    tmuxName,
    workdir: null,
    timeoutMs,
  });

  if (await tmux.hasSession(tmuxName)) {
    await tmux.killSession(tmuxName);
  }

  const newId = randomUUID();
  if (hookEventsPath) {
    writeClaudeSettings(cwd, hookEventsPath, newId);
  }

  await launchSession({
    tmux, bus,
    sessionId: newId,
    tmuxName,
    cwd,
    timeoutMs,
  });
  return newId;
}
