import type { ApiErrorCode } from "./error";

export function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

export function errorResponse(status: number, code: ApiErrorCode, message: string, requestId?: string): Response {
  return jsonResponse(status, { error: code, message, request_id: requestId });
}
