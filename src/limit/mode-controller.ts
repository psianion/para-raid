import type { DaemonMode } from "../types";

export function createModeController() {
  let current: DaemonMode = "running";
  const listeners: Array<(mode: DaemonMode) => void> = [];

  return {
    mode: () => current,
    isPaused: () => current === "paused",
    pause() { current = "paused"; for (const l of listeners) l(current); },
    resume() { current = "running"; for (const l of listeners) l(current); },
    onModeChange(fn: (mode: DaemonMode) => void) { listeners.push(fn); },
  };
}
export type ModeController = ReturnType<typeof createModeController>;
