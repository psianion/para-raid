import { randomUUID } from "node:crypto";

export interface ApiResult {
  status: number;
  body: any;
}

export interface ReferenceClient {
  openSession(req: { adapter_ref: string; prompt: string; bundle_name?: string }): Promise<ApiResult>;
  sendTurn(req: { session_id: string; prompt: string }): Promise<ApiResult>;
  closeSession(req: { session_id: string }): Promise<ApiResult>;
}

/**
 * Minimal para-raid control client over the daemon's unix socket.
 *
 * Identity is the per-adapter bearer token ALONE — the daemon derives the
 * caller's adapter id from the token and ignores any X-Adapter-Id header. Every
 * mutating call sends a fresh `Idempotency-Key` so a network retry is a no-op
 * server-side (the daemon caches the first 2xx response per key for 24h).
 *
 * This is deliberately dependency-free so it can be copied straight into a real
 * adapter (a Discord bot, a web backend, …) as the starting point.
 */
export function createReferenceClient(opts: { socketPath: string; token: string }): ReferenceClient {
  async function call(path: string, body: unknown): Promise<ApiResult> {
    const res = await fetch(`http://para-raid${path}`, {
      method: "POST",
      // Bun routes the request over the unix socket; the host is ignored.
      unix: opts.socketPath,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.token}`,
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify(body),
    } as any);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  }

  return {
    openSession: (req) => call("/v1/open_session", req),
    sendTurn: (req) => call("/v1/send_turn", req),
    closeSession: (req) => call("/v1/close_session", req),
  };
}
