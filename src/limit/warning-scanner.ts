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

/** Quota self-pause: if a completed turn's text trips the limit regex, pause the
 *  daemon so it stops burning quota. Returns true iff it paused this call. No-op
 *  when there's no regex, no match, or the daemon is already paused (incl. a
 *  manual pause). The operator resumes when ready. */
export function pauseIfLimitReached(
  text: string,
  regex: RegExp | null,
  mode: { isPaused(): boolean; pause(): void },
  logger: { warn(event: string, meta?: unknown): void },
): boolean {
  if (!regex) return false;
  const scanned = text.length > SCAN_TAIL ? text.slice(-SCAN_TAIL) : text;
  if (!scanForWarning(scanned, regex)) return false;
  if (mode.isPaused()) return false;
  mode.pause();
  logger.warn("limit.auto_pause", { reason: "usage_warning_detected" });
  return true;
}
