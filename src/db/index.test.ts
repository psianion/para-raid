import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createDb } from "./index";
import { up as migration001 } from "./migrations/001_initial";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

test("createDb creates a missing parent directory (fresh-boot data_dir)", () => {
  // On a fresh box the data_dir has never been created. createDb must
  // create it rather than crash-looping with SQLITE_CANTOPEN.
  const base = mkdtempSync(join(tmpdir(), "para-raid-db-"));
  const dataDir = join(base, "state", "para-raid"); // does NOT exist yet
  const dbPath = join(dataDir, "para-raid.db");
  expect(existsSync(dataDir)).toBe(false);

  const db = createDb(dbPath);

  expect(existsSync(dbPath)).toBe(true);
  const row = db.raw.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
  ).get();
  expect(row?.name).toBe("sessions");

  db.close();
  rmSync(base, { recursive: true, force: true });
});

test("creates all tables at the current schema version and runs transaction", () => {
  const db = createDb(":memory:");
  const tables = db.raw.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);

  expect(tables).toContain("sessions");
  expect(tables).toContain("turns");
  expect(tables).toContain("webhook_queue");
  expect(tables).toContain("idempotency_keys");
  expect(tables).toContain("transcript_offsets");
  expect(tables).toContain("schema_migrations");
  expect(tables).not.toContain("tailer_state");

  const cols = db.raw.query<{ name: string }, []>("PRAGMA table_info(sessions)").all().map((c) => c.name);
  expect(cols).not.toContain("tmux_session");

  const version = db.raw.query<{ v: number }, []>("SELECT MAX(version) as v FROM schema_migrations").get();
  expect(version?.v).toBe(2);

  const result = db.transaction(() => {
    db.raw.run("INSERT INTO sessions (id, adapter_id, adapter_ref, cwd, mcp_bundle, webhook_url, status, created_at, updated_at) VALUES ('s1','uxie','ch1','/tmp','scrypt','http://localhost','launching',1,1)");
    return db.raw.query<{ id: string }, []>("SELECT id FROM sessions").get();
  });
  expect(result?.id).toBe("s1");
});

test("migrates a version-1 database forward and keeps its rows", () => {
  const base = mkdtempSync(join(tmpdir(), "para-raid-db-v1-"));
  const dbPath = join(base, "para-raid.db");

  // Build a v1 database the way the old daemon would have left it.
  const legacy = new Database(dbPath);
  migration001(legacy);
  legacy.run("INSERT INTO sessions (id, adapter_id, adapter_ref, tmux_session, cwd, mcp_bundle, webhook_url, status, created_at, updated_at) VALUES ('old','uxie','ref','para-raid-abc','/tmp/wd','','http://localhost','live',1,1)");
  legacy.close();

  const db = createDb(dbPath);
  const version = db.raw.query<{ v: number }, []>("SELECT MAX(version) as v FROM schema_migrations").get();
  expect(version?.v).toBe(2);
  const row = db.raw.query<{ id: string; cwd: string; status: string }, []>("SELECT id, cwd, status FROM sessions").get();
  expect(row).toEqual({ id: "old", cwd: "/tmp/wd", status: "live" });
  const cols = db.raw.query<{ name: string }, []>("PRAGMA table_info(sessions)").all().map((c) => c.name);
  expect(cols).not.toContain("tmux_session");

  db.close();
  rmSync(base, { recursive: true, force: true });
});

test("transaction rolls back on error", () => {
  const db = createDb(":memory:");
  expect(() => {
    db.transaction(() => {
      db.raw.run("INSERT INTO sessions (id, adapter_id, adapter_ref, cwd, mcp_bundle, webhook_url, status, created_at, updated_at) VALUES ('s2','uxie','ch2','/tmp','scrypt','http://localhost','launching',1,1)");
      throw new Error("rollback test");
    });
  }).toThrow("rollback test");
  const row = db.raw.query<{ id: string }, []>("SELECT id FROM sessions WHERE id='s2'").get();
  expect(row).toBeNull();
});
