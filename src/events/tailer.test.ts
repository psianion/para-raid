// src/events/tailer.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { startTailer } from "./tailer";
import { createEventBus } from "./bus";
import { createDb } from "../db";
import type { HookEvent } from "../types";

const BASE = "/tmp/pararaid-w2-tailer";
let DIR: string;
let FILE: string;

beforeEach(() => {
  DIR = `${BASE}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  FILE = `${DIR}/hook-events.jsonl`;
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, "");
});
afterEach(() => { rmSync(DIR, { recursive: true, force: true }); });

test("tailer reads existing lines and persists offset", async () => {
  const db = createDb(":memory:");
  const bus = createEventBus();
  const seen: HookEvent[] = [];
  bus.subscribe((e) => seen.push(e));

  appendFileSync(FILE, JSON.stringify({ hook_event_name: "SessionStart", session_id: "s1", cwd: "/tmp" }) + "\n");
  const tailer = startTailer(FILE, db, bus);
  await new Promise(r => setTimeout(r, 200));

  expect(seen.length).toBeGreaterThanOrEqual(1);
  expect(seen[0].hook_event_name).toBe("SessionStart");

  const cursor = db.raw.query<{ offset: number }, []>("SELECT offset FROM tailer_state WHERE id='singleton'").get();
  expect(cursor!.offset).toBeGreaterThan(0);

  await tailer.stop();
  db.close();
});

// Regression: a real daemon never pre-creates hook-events.jsonl, so the tailer
// must create it before watching — otherwise the first hook write arrives as a
// chokidar `add` (not `change`) and the launch SessionStart is lost. (The other
// tests pre-create the file in beforeEach, which is what hid the bug.)
test("tailer creates a missing file and still delivers the first appended event", async () => {
  const db = createDb(":memory:");
  const bus = createEventBus();
  const seen: HookEvent[] = [];
  bus.subscribe((e) => seen.push(e));

  const missing = `${DIR}/not-created-yet.jsonl`;
  expect(existsSync(missing)).toBe(false);
  const tailer = startTailer(missing, db, bus);
  expect(existsSync(missing)).toBe(true); // touched before watching

  appendFileSync(missing, JSON.stringify({ hook_event_name: "SessionStart", session_id: "s3", cwd: "/tmp" }) + "\n");
  await new Promise(r => setTimeout(r, 1500));

  expect(seen.some((e) => e.hook_event_name === "SessionStart" && e.session_id === "s3")).toBe(true);

  await tailer.stop();
  db.close();
});

test("tailer routes SessionEnd to onSessionEnd handler", async () => {
  const db = createDb(":memory:");
  const bus = createEventBus();
  const ends: HookEvent[] = [];
  bus.onSessionEnd((e) => ends.push(e));

  const tailer = startTailer(FILE, db, bus);
  await new Promise(r => setTimeout(r, 100));
  appendFileSync(FILE, JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s2", cwd: "/tmp", reason: "external_kill" }) + "\n");
  await new Promise(r => setTimeout(r, 1500));

  expect(ends.length).toBe(1);
  expect(ends[0].session_id).toBe("s2");

  await tailer.stop();
  db.close();
});
