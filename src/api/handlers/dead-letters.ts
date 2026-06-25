import { z } from "zod";
import { ADMIN_ID, type Handler } from "../router";
import { jsonResponse, errorResponse } from "../envelope";

interface DeadLetterRow {
  id: number;
  event_id: string;
  session_id: string | null;
  adapter_id: string;
  event_type: string;
  payload_json: string;
  webhook_url: string;
  status: string;
  attempt_count: number;
  next_attempt_at: number;
  first_attempted_at: number | null;
  last_error: string | null;
  created_at: number;
}

export const deadLettersListHandler: Handler = async (req, ctx) => {
  const url = new URL(req.url);
  // Admin may filter by any adapter_id (or none); a regular adapter only ever
  // sees its own dead letters regardless of the query param.
  const adapterId = ctx.adapter_id === ADMIN_ID
    ? url.searchParams.get("adapter_id")
    : (ctx.adapter_id ?? null);

  const sql = adapterId
    ? `SELECT id, event_id, session_id, adapter_id, event_type, payload_json, webhook_url,
              status, attempt_count, next_attempt_at, first_attempted_at, last_error, created_at
       FROM webhook_queue WHERE status = 'dead_letter' AND adapter_id = ? ORDER BY created_at`
    : `SELECT id, event_id, session_id, adapter_id, event_type, payload_json, webhook_url,
              status, attempt_count, next_attempt_at, first_attempted_at, last_error, created_at
       FROM webhook_queue WHERE status = 'dead_letter' ORDER BY created_at`;

  const rows = adapterId
    ? (ctx.db.raw.query<DeadLetterRow, [string]>(sql).all(adapterId) as DeadLetterRow[])
    : (ctx.db.raw.query<DeadLetterRow, []>(sql).all() as DeadLetterRow[]);

  return jsonResponse(200, { dead_letters: rows });
};

const AckReq = z.object({
  event_ids: z.array(z.string().min(1)).min(1),
});

export const deadLettersAckHandler: Handler = async (req, ctx) => {
  const body = await req.json().catch(() => null);
  const parsed = AckReq.safeParse(body);
  if (!parsed.success) return errorResponse(400, "invalid_request", parsed.error.message, ctx.requestId);

  const ids = parsed.data.event_ids;
  const placeholders = ids.map(() => "?").join(",");
  // A regular adapter may only ack its own dead letters; admin acks anything.
  // Scoping the UPDATE (rather than rejecting) means a partial-foreign batch
  // still acks the rows the caller owns.
  const isAdmin = ctx.adapter_id === ADMIN_ID;
  const scopeSql = isAdmin ? "" : " AND adapter_id = ?";
  const scopeArgs = isAdmin ? ids : [...ids, ctx.adapter_id ?? ""];
  const result = ctx.db.raw.run(
    `UPDATE webhook_queue SET status = 'delivered'
     WHERE status = 'dead_letter' AND event_id IN (${placeholders})${scopeSql}`,
    scopeArgs,
  );

  return jsonResponse(200, { acknowledged: result.changes });
};
