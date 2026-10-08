import type { Database } from "bun:sqlite";

/**
 * Workers are stdio child processes keyed by session id; there is no tmux
 * pane name to record any more. The hook-events tailer is gone too, so its
 * cursor table goes with it. (Forward-only, like 001.)
 */
export function up(db: Database): void {
  db.run(`ALTER TABLE sessions DROP COLUMN tmux_session`);
  db.run(`DROP TABLE IF EXISTS tailer_state`);
  db.run(`INSERT INTO schema_migrations (version, applied_at) VALUES (2, ${Date.now()})`);
}
