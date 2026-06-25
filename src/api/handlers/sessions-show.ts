import { assertOwnership, type Handler } from "../router";
import { jsonResponse, errorResponse } from "../envelope";
import { findTranscriptForCwd } from "../../transcript/locator";

interface SessionRow {
  id: string;
  adapter_id: string;
  adapter_ref: string;
  status: string;
  tmux_session: string;
  cwd: string;
  mcp_bundle: string;
  webhook_url: string;
  created_at: number;
  updated_at: number;
  last_turn_at: number | null;
  recovery_expires_at: number | null;
}

interface TurnRow {
  id: string;
  session_id: string;
  status: string;
  prompt_sha256: string;
  created_at: number;
  dispatched_at: number | null;
  completed_at: number | null;
  error: string | null;
}

export const sessionsShowHandler: Handler = async (_req, ctx, params) => {
  const id = params.id;
  if (!id) return errorResponse(400, "invalid_request", "missing session id", ctx.requestId);

  const sess = ctx.db.raw.query<SessionRow, [string]>(
    `SELECT id, adapter_id, adapter_ref, status, tmux_session, cwd, mcp_bundle, webhook_url,
            created_at, updated_at, last_turn_at, recovery_expires_at
     FROM sessions WHERE id = ?`,
  ).get(id) as SessionRow | null;
  if (!sess) return errorResponse(404, "not_found", "no session with that id", ctx.requestId);
  assertOwnership(ctx, sess.adapter_id);

  const latestTurn = ctx.db.raw.query<TurnRow, [string]>(
    `SELECT id, session_id, status, prompt_sha256, created_at, dispatched_at, completed_at, error
     FROM turns WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(id) as TurnRow | null;

  const transcriptPath = findTranscriptForCwd(sess.cwd);

  return jsonResponse(200, {
    session: sess,
    latest_turn: latestTurn,
    transcript_path: transcriptPath,
  });
};
