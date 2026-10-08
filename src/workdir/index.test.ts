import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, statSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { provisionWorkdir, cleanupWorkdir } from "./index";

const BASE = "/tmp/pararaid-workdir-test";
// POSIX file modes don't exist on Windows; meaningful only on the Linux deploy target.
const posixOnly = test.skipIf(process.platform === "win32");

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
});

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true });
});

test("provisionWorkdir creates the session dir under workdirs/", () => {
  const p = provisionWorkdir(BASE, "abc123");
  expect(p).toBe(join(BASE, "workdirs", "abc123"));
  expect(existsSync(p)).toBe(true);
});

test("cleanupWorkdir removes the dir", () => {
  const p = provisionWorkdir(BASE, "abc123");
  expect(existsSync(p)).toBe(true);
  cleanupWorkdir(p);
  expect(existsSync(p)).toBe(false);
});

posixOnly("workdir is mode 0700", () => {
  const p = provisionWorkdir(BASE, "mode-test");
  const m = statSync(p).mode & 0o777;
  expect(m).toBe(0o700);
});
