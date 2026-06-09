import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { up as migration001 } from "./migrations/001_initial";

export interface Db {
  raw: Database;
  transaction: <T>(fn: () => T) => T;
  close: () => void;
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

  try {
    const current = raw.query<{ version: number }, []>(
      "SELECT MAX(version) as version FROM schema_migrations"
    ).get();
    if (!current || current.version < 1) {
      migration001(raw);
    }
  } catch {
    migration001(raw);
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
