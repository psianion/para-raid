import type { Handler } from "../router";
import { jsonResponse, errorResponse } from "../envelope";

interface SessionRow {
  id: string;
  adapter_id: string;
  adapter_ref: string;
  status: string;
  tmux_session: string;
  cwd: string;
  created_at: number;
  updated_at: number;
  last_turn_at: number | null;
  recovery_expires_at: number | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const sessionsListHandler: Handler = async (req, ctx) => {
  const url = new URL(req.url);
  const adapterId = url.searchParams.get("adapter_id");
  const status = url.searchParams.get("status");
  const limitRaw = url.searchParams.get("limit");
  const cursorRaw = url.searchParams.get("cursor");

  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n <= 0) return errorResponse(400, "invalid_request", "limit must be a positive integer", ctx.requestId);
    limit = Math.min(Math.floor(n), MAX_LIMIT);
  }

  let cursor: number | null = null;
  if (cursorRaw !== null) {
    const c = Number(cursorRaw);
    if (!Number.isFinite(c)) return errorResponse(400, "invalid_request", "cursor must be a number", ctx.requestId);
    cursor = c;
  }

  const where: string[] = [];
  const args: Array<string | number> = [];
  if (cursor !== null) { where.push("created_at < ?"); args.push(cursor); }
  if (adapterId)       { where.push("adapter_id = ?"); args.push(adapterId); }
  if (status)          { where.push("status = ?");     args.push(status); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sql = `SELECT id, adapter_id, adapter_ref, status, tmux_session, cwd,
                      created_at, updated_at, last_turn_at, recovery_expires_at
               FROM sessions ${whereSql}
               ORDER BY created_at DESC
               LIMIT ?`;
  args.push(limit);

  const rows = ctx.db.raw.query<SessionRow, typeof args>(sql).all(...args) as SessionRow[];
  const nextCursor = rows.length === limit ? rows[rows.length - 1].created_at : null;

  return jsonResponse(200, { sessions: rows, next_cursor: nextCursor });
};
