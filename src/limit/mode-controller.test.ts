import { test, expect } from "bun:test";
import { createModeController } from "./mode-controller";
import { scanForWarning } from "./warning-scanner";

test("mode controller starts running, can pause and resume", () => {
  const mc = createModeController();
  expect(mc.mode()).toBe("running");
  mc.pause();
  expect(mc.mode()).toBe("paused");
  expect(mc.isPaused()).toBe(true);
  mc.resume();
  expect(mc.mode()).toBe("running");
  expect(mc.isPaused()).toBe(false);
});

test("onModeChange fires on transitions", () => {
  const mc = createModeController();
  const seen: string[] = [];
  mc.onModeChange((m) => seen.push(m));
  mc.pause();
  mc.resume();
  expect(seen).toEqual(["paused", "running"]);
});

test("warning scanner detects quota warning", () => {
  expect(scanForWarning("You are approaching your usage limit", /approaching\s+your.*limit/i)).toBe(true);
});

test("warning scanner returns false for normal text", () => {
  expect(scanForWarning("Hello, how can I help you?", /approaching\s+your.*limit/i)).toBe(false);
});
