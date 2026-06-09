import { totalmem } from "os";
import { readFileSync } from "fs";
import type { ModeController } from "./mode-controller";
import type { Logger } from "../logger";

/** Interpret a cgroup memory limit ("max", a byte count, or the v1 "unlimited"
 *  sentinel) against the physical-RAM fallback, returning the smaller real cap. */
export function parseMemoryMax(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const t = raw.trim();
  if (t === "" || t === "max") return fallback;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.min(n, fallback) : fallback;
}

/** The memory cap the daemon actually runs under: the cgroup limit (v2 then v1)
 *  when present, else physical RAM. This is what the valve must pre-empt — a
 *  systemd MemoryMax well below physical RAM is the common VPS case. */
function detectMemoryLimitBytes(): number {
  const total = totalmem();
  try { return parseMemoryMax(readFileSync("/sys/fs/cgroup/memory.max", "utf8"), total); } catch { /* not cgroup v2 */ }
  try { return parseMemoryMax(readFileSync("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf8"), total); } catch { /* not cgroup v1 */ }
  return total;
}

/** The daemon's own resident set as a percentage of its memory cap. Soft
 *  early-pause; the systemd MemoryMax remains the hard cap. */
export function currentRamPct(): number {
  return (process.memoryUsage().rss / detectMemoryLimitBytes()) * 100;
}

/**
 * Cost/stability safety valve: when memory crosses `refusePct` it pauses the
 * daemon (new open_session/send_turn return 503); when it falls back below
 * `warnPct` it auto-resumes. The warn<refuse gap is the hysteresis band that
 * prevents flapping. It never resumes a pause it didn't cause (e.g. an operator
 * `pause`). `sample` is injectable for tests.
 */
export function startRamValve(
  modeController: ModeController,
  opts: { warnPct: number; refusePct: number; intervalMs: number },
  logger: Logger,
  sample: () => number = currentRamPct,
) {
  let valvePaused = false;
  let running = true;
  let lastBand = "";

  function tick() {
    const pct = sample();
    if (!modeController.isPaused()) valvePaused = false; // running ⇒ any prior valve pause was lifted

    let band: "ok" | "warn" | "refuse";
    if (pct >= opts.refusePct) {
      band = "refuse";
      if (!modeController.isPaused()) {
        modeController.pause();
        valvePaused = true;
        logger.warn("ram_valve.pause", { pct: Math.round(pct), refuse_pct: opts.refusePct });
      }
    } else if (pct < opts.warnPct) {
      band = "ok";
      if (valvePaused && modeController.isPaused()) {
        modeController.resume();
        valvePaused = false;
        logger.info("ram_valve.resume", { pct: Math.round(pct) });
      }
    } else {
      band = "warn";
      if (lastBand !== "warn") logger.warn("ram_valve.warn", { pct: Math.round(pct), warn_pct: opts.warnPct });
    }
    lastBand = band;
  }

  const interval = setInterval(() => { if (running) tick(); }, opts.intervalMs);
  return { stop() { running = false; clearInterval(interval); }, tick };
}
