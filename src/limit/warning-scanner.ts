import type { WorkerEvent } from "../worker/runtime";

export function scanForWarning(text: string, warningRegex: RegExp): boolean {
  return warningRegex.test(text);
}

/** Longest reply suffix scanned for a limit warning. Bounds regex runtime
 *  regardless of reply size (the shipped pattern can backtrack on long whitespace
 *  runs); limit banners appear at the end of a turn anyway. */
const SCAN_TAIL = 4000;

/** Compile a limit-warning pattern into a RegExp, translating a leading PCRE
 *  inline-flag group (the shipped pattern starts with `(?i)`) into JS RegExp
 *  flags — JS does not accept inline flags. Returns null for a blank or
 *  flag-only pattern, which would otherwise compile to a match-everything regex
 *  and pause every turn. */
export function compileWarningRegex(pattern: string): RegExp | null {
  let src = pattern;
  let flags = "";
  const m = src.match(/^\(\?([a-z]+)\)/);
  if (m) {
    if (m[1].includes("i")) flags += "i";
    if (m[1].includes("m")) flags += "m";
    if (m[1].includes("s")) flags += "s";
    src = src.slice(m[0].length);
  }
  if (src.trim() === "") return null;
  return new RegExp(src, flags);
}

type Mode = { isPaused(): boolean; pause(): void };
type WarnLogger = { warn(event: string, meta?: unknown): void };

/** Quota self-pause: if a completed turn's text trips the limit regex, pause the
 *  daemon so it stops burning quota. Returns true iff it paused this call. No-op
 *  when there's no regex, no match, or the daemon is already paused (incl. a
 *  manual pause). The operator resumes when ready. */
export function pauseIfLimitReached(
  text: string,
  regex: RegExp | null,
  mode: Mode,
  logger: WarnLogger,
): boolean {
  if (!regex) return false;
  const scanned = text.length > SCAN_TAIL ? text.slice(-SCAN_TAIL) : text;
  if (!scanForWarning(scanned, regex)) return false;
  if (mode.isPaused()) return false;
  mode.pause();
  logger.warn("limit.auto_pause", { reason: "usage_warning_detected" });
  return true;
}

/** Wire the scanner into the worker-event bus: any result whose reply trips
 *  the regex pauses the daemon. Covers what the dispatcher's onDispatch scan
 *  misses — a result landing after a turn timeout, or a session driven
 *  outside the dispatcher. */
export function watchResultEventsForWarning(
  bus: { subscribe(fn: (event: WorkerEvent) => void): unknown },
  regex: RegExp | null,
  mode: Mode,
  logger: WarnLogger,
): void {
  if (!regex) return;
  bus.subscribe((event) => {
    if (event.type !== "result") return;
    pauseIfLimitReached(event.result, regex, mode, logger);
  });
}

/** claude reports its own quota state after each turn (`rate_limit_event`).
 *  Anything other than `allowed` means the next turn would be refused, so pause
 *  now instead of discovering it as a failed turn. Returns true iff paused. */
export function pauseIfRateLimited(
  event: Extract<WorkerEvent, { type: "rate_limit" }>,
  mode: Mode,
  logger: WarnLogger,
): boolean {
  if (event.status === "allowed" || event.status === "unknown") return false;
  if (mode.isPaused()) return false;
  mode.pause();
  logger.warn("limit.auto_pause", {
    reason: "rate_limit_event",
    status: event.status,
    rate_limit_type: event.rate_limit_type,
    resets_at: event.resets_at,
    utilization: event.utilization,
  });
  return true;
}

export function watchRateLimitEvents(
  bus: { subscribe(fn: (event: WorkerEvent) => void): unknown },
  mode: Mode,
  logger: WarnLogger,
): void {
  bus.subscribe((event) => {
    if (event.type !== "rate_limit") return;
    pauseIfRateLimited(event, mode, logger);
  });
}
