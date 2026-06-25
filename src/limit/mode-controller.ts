import type { DaemonMode } from "../types";

export function createModeController() {
  let current: DaemonMode = "running";
  return {
    mode: () => current,
    isPaused: () => current === "paused",
    pause() { current = "paused"; },
    resume() { current = "running"; },
  };
}
export type ModeController = ReturnType<typeof createModeController>;
