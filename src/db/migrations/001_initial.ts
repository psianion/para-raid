import type { Database } from "bun:sqlite";

export function up(db: Database): void {
  db.run(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, adapter_id TEXT NOT NULL, adapter_ref TEXT NOT NULL,
    tmux_session TEXT NOT NULL, cwd TEXT NOT NULL, mcp_bundle TEXT NOT NULL,
    webhook_url TEXT NOT NULL, status TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_turn_at INTEGER, recovery_expires_at INTEGER
  )`);
  db.run(`CREATE UNIQUE INDEX sessions_adapter_ref_active ON sessions(adapter_id, adapter_ref) WHERE status IN ('launching','live','recovering')`);
  db.run(`CREATE INDEX sessions_status ON sessions(status)`);

  db.run(`CREATE TABLE turns (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    status TEXT NOT NULL, prompt_sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL, dispatched_at INTEGER, completed_at INTEGER, error TEXT
  )`);
  db.run(`CREATE INDEX turns_session_id ON turns(session_id)`);
  db.run(`CREATE INDEX turns_status ON turns(status)`);

  db.run(`CREATE TABLE webhook_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
    session_id TEXT, adapter_id TEXT NOT NULL, event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL, webhook_url TEXT NOT NULL,
    status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL, first_attempted_at INTEGER,
    last_error TEXT, created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX webhook_queue_pending ON webhook_queue(status, next_attempt_at) WHERE status IN ('pending','in_flight')`);
  db.run(`CREATE INDEX webhook_queue_dead_letters ON webhook_queue(adapter_id, status) WHERE status='dead_letter'`);

  db.run(`CREATE TABLE idempotency_keys (
    key TEXT PRIMARY KEY, adapter_id TEXT NOT NULL, endpoint TEXT NOT NULL,
    response_status INTEGER NOT NULL, response_json TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`);
  db.run(`CREATE INDEX idempotency_keys_expires ON idempotency_keys(expires_at)`);

  db.run(`CREATE TABLE transcript_offsets (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    transcript_path TEXT NOT NULL, last_scanned_offset INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE tailer_state (
    id TEXT PRIMARY KEY DEFAULT 'singleton' CHECK (id='singleton'),
    file_path TEXT NOT NULL, file_inode INTEGER NOT NULL,
    offset INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  db.run(`INSERT INTO schema_migrations (version, applied_at) VALUES (1, ${Date.now()})`);
}
