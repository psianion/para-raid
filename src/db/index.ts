import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { up as migration001 } from "./migrations/001_initial";
import { up as migration002 } from "./migrations/002_drop_tmux_session";

export interface Db {
  raw: Database;
  transaction: <T>(fn: () => T) => T;
  close: () => void;
}

const MIGRATIONS: Array<{ version: number; up: (db: Database) => void }> = [
  { version: 1, up: migration001 },
  { version: 2, up: migration002 },
];

function currentVersion(raw: Database): number {
  try {
    const row = raw.query<{ version: number | null }, []>(
      "SELECT MAX(version) as version FROM schema_migrations"
    ).get();
    return row?.version ?? 0;
  } catch {
    return 0; // no schema_migrations table yet
  }
}

export function createDb(path: string): Db {
  // On a fresh box the data_dir may not exist yet; create it so we don't
  // crash-loop with SQLITE_CANTOPEN. Skip for in-memory databases.
  if (path !== ":memory:" && !path.startsWith("file::memory:")) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }

  const raw = new Database(path);
  raw.run("PRAGMA journal_mode=WAL");
  raw.run("PRAGMA busy_timeout=5000");
  raw.run("PRAGMA synchronous=NORMAL");
  raw.run("PRAGMA foreign_keys=ON");

  let version = currentVersion(raw);
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    raw.transaction(() => m.up(raw))();
    version = m.version;
  }

  return {
    raw,
    transaction<T>(fn: () => T): T {
      return raw.transaction(fn)();
    },
    close() {
      raw.close();
    },
  };
}
