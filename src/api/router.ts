import type { Db } from "../db";
import type { EventBus } from "../events/bus";
import type { TmuxAdapter } from "../tmux/adapter";
import type { Logger } from "../logger";
import type { ParaRaidConfig } from "../types";
import type { ModeController } from "../limit/mode-controller";
import type { Dispatcher } from "../sessions/dispatcher";
import type { Bundle } from "../bundles/loader";
import { errorResponse, jsonResponse } from "./envelope";
import { ApiError } from "./error";

/** Identity assigned to a caller presenting the global config.auth.token.
 *  Admin bypasses per-adapter ownership checks. The boot gate
 *  (checkAuthSecurity) refuses to start if an adapter is named "__admin__",
 *  so this sentinel can never collide with a real adapter id. */
export const ADMIN_ID = "__admin__";

export interface HandlerCtx {
  db: Db;
  bus: EventBus;
  tmux: TmuxAdapter;
  logger: Logger;
  config: ParaRaidConfig;
  modeController: ModeController;
  dispatcher: Dispatcher;
  hookEventsPath: string;       // for recycler
  bundles?: Bundle[];           // MCP bundles loaded at boot; rendered per session
  requestId?: string;           // injected by request-id middleware
  adapter_id?: string;          // injected by auth middleware (the authenticated caller)
}

/** Throws 403 unless the caller owns the session (or is admin). One helper for
 *  the 5 session-owning ops, caught by createRouter's ApiError branch. */
export function assertOwnership(ctx: HandlerCtx, sessionAdapterId: string): void {
  if (ctx.adapter_id === ADMIN_ID || ctx.adapter_id === sessionAdapterId) return;
  throw new ApiError(403, "forbidden", "caller does not own this session");
}

/** Throws 403 unless the caller is admin. For daemon-wide ops (pause/resume,
 *  stats, status). Caught by createRouter's ApiError branch. */
export function assertAdmin(ctx: HandlerCtx): void {
  if (ctx.adapter_id === ADMIN_ID) return;
  throw new ApiError(403, "forbidden", "admin token required");
}

export type Handler = (req: Request, ctx: HandlerCtx, params: Record<string, string>) => Promise<Response>;

export interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

export function createRouter(routes: Route[], ctx: HandlerCtx): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const m = url.pathname.match(route.pattern);
      if (!m) continue;
      try {
        return await route.handler(req, ctx, m.groups ?? {});
      } catch (err) {
        if (err instanceof ApiError) return errorResponse(err.status, err.code, err.message, ctx.requestId);
        ctx.logger.error("router.handler_throw", { path: url.pathname, error: String(err) });
        return errorResponse(500, "internal", "internal error", ctx.requestId);
      }
    }
    return errorResponse(404, "not_found", `no route for ${req.method} ${url.pathname}`, ctx.requestId);
  };
}
