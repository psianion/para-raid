import { test, expect } from "bun:test";
import { scanForWarning, compileWarningRegex, pauseIfLimitReached } from "./warning-scanner";
import { createModeController } from "./mode-controller";

const NOOP = { info() {}, warn() {}, error() {} } as any;

test("compileWarningRegex strips a leading (?i) inline flag and applies case-insensitivity", () => {
  const re = compileWarningRegex("(?i)approaching your usage limit")!;
  expect(re.flags).toContain("i");
  expect(re.test("APPROACHING YOUR USAGE LIMIT")).toBe(true);
});

test("compileWarningRegex returns null for blank or flag-only patterns (which would match every turn)", () => {
  expect(compileWarningRegex("")).toBeNull();
  expect(compileWarningRegex("   ")).toBeNull();
  expect(compileWarningRegex("(?i)")).toBeNull();
  expect(compileWarningRegex("(?i)  ")).toBeNull();
});

test("scanForWarning matches the shipped example warning phrasing", () => {
  const re = compileWarningRegex(
    "(?i)(approaching\\s+(your\\s+)?(session|weekly|opus|sonnet|(extra\\s+)?usage)\\s+limit|you're\\s+close\\s+to\\s+your\\s+(usage\\s+)?limit)"
  )!;
  expect(scanForWarning("You're close to your usage limit", re)).toBe(true);
  expect(scanForWarning("here is your answer: 42", re)).toBe(false);
});

test("pauseIfLimitReached scans only the tail of a very long reply (bounds backtracking cost)", () => {
  const mc = createModeController();
  const re = compileWarningRegex("(?i)START")!;
  // a match near the very start of a huge reply is past the tail window → ignored
  expect(pauseIfLimitReached("START" + "x".repeat(8000), re, mc, NOOP)).toBe(false);
  expect(mc.isPaused()).toBe(false);
  // a match at the end is still caught (limit banners appear at the end)
  expect(pauseIfLimitReached("x".repeat(8000) + " START here", re, mc, NOOP)).toBe(true);
});

test("pauseIfLimitReached pauses on a match and is a no-op otherwise", () => {
  const mc = createModeController();
  const re = compileWarningRegex("(?i)approaching your .* limit");
  expect(pauseIfLimitReached("all good", re, mc, NOOP)).toBe(false);
  expect(mc.isPaused()).toBe(false);
  expect(pauseIfLimitReached("Approaching your weekly limit", re, mc, NOOP)).toBe(true);
  expect(mc.isPaused()).toBe(true);
});

test("pauseIfLimitReached does not double-pause and tolerates a null regex", () => {
  const mc = createModeController();
  mc.pause();
  const re = compileWarningRegex("(?i)limit");
  expect(pauseIfLimitReached("over the limit", re, mc, NOOP)).toBe(false); // already paused
  expect(pauseIfLimitReached("over the limit", null, mc, NOOP)).toBe(false); // no regex configured
});
