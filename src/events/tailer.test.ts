// src/events/tailer.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "fs";
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
