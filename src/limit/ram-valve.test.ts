import { test, expect } from "bun:test";
import { startRamValve, parseMemoryMax } from "./ram-valve";
import { createModeController } from "./mode-controller";

test("parseMemoryMax clamps to the fallback for max/blank/unlimited, else the smaller real limit", () => {
  expect(parseMemoryMax("max", 1000)).toBe(1000);
  expect(parseMemoryMax(null, 1000)).toBe(1000);
  expect(parseMemoryMax("", 1000)).toBe(1000);
  expect(parseMemoryMax("500", 1000)).toBe(500);
  expect(parseMemoryMax("5000", 1000)).toBe(1000);              // cgroup limit above physical RAM
  expect(parseMemoryMax("9223372036854771712", 1000)).toBe(1000); // cgroup v1 "unlimited" sentinel
});

const NOOP = { info() {}, warn() {}, error() {} } as any;
const THRESH = { warnPct: 75, refusePct: 90, intervalMs: 999999 };

test("ram valve pauses when usage crosses the refuse threshold", () => {
  const mc = createModeController();
  let pct = 10;
  const v = startRamValve(mc, THRESH, NOOP, () => pct);
  v.tick();
  expect(mc.isPaused()).toBe(false);
  pct = 95;
  v.tick();
  expect(mc.isPaused()).toBe(true);
  v.stop();
});

test("ram valve auto-resumes once usage drops below the warn threshold (hysteresis)", () => {
  const mc = createModeController();
  let pct = 95;
  const v = startRamValve(mc, THRESH, NOOP, () => pct);
  v.tick();
  expect(mc.isPaused()).toBe(true);
  pct = 80; // still in warn band — must NOT resume yet
  v.tick();
  expect(mc.isPaused()).toBe(true);
  pct = 50;
  v.tick();
  expect(mc.isPaused()).toBe(false);
  v.stop();
});

test("ram valve does not resume a manual (operator) pause", () => {
  const mc = createModeController();
  let pct = 50;
  const v = startRamValve(mc, THRESH, NOOP, () => pct);
  mc.pause();
  v.tick();
  expect(mc.isPaused()).toBe(true);
  v.stop();
});

test("ram valve stays running while in the warn band", () => {
  const mc = createModeController();
  const v = startRamValve(mc, THRESH, NOOP, () => 80);
  v.tick();
  expect(mc.isPaused()).toBe(false);
  v.stop();
});
