import type { Route } from "./router";
import { withMiddleware } from "./serve";
import { openSessionHandler } from "./handlers/open-session";
import { closeSessionHandler } from "./handlers/close-session";
import { recycleSessionHandler } from "./handlers/recycle-session";
import { sendTurnHandler } from "./handlers/send-turn";
import { cancelTurnHandler } from "./handlers/cancel-turn";
import { resumeSessionHandler } from "./handlers/resume-session";
import { pauseHandler } from "./handlers/pause";
import { resumeHandler } from "./handlers/resume";
import { statusHandler } from "./handlers/status";
import { sessionsListHandler } from "./handlers/sessions-list";
import { sessionsShowHandler } from "./handlers/sessions-show";
import { statsHandler } from "./handlers/stats";
import { deadLettersListHandler, deadLettersAckHandler } from "./handlers/dead-letters";

export const routes: Route[] = [
  { method: "POST", pattern: /^\/v1\/open_session$/,          handler: withMiddleware(openSessionHandler) },
  { method: "POST", pattern: /^\/v1\/close_session$/,         handler: withMiddleware(closeSessionHandler) },
  { method: "POST", pattern: /^\/v1\/recycle_session$/,       handler: withMiddleware(recycleSessionHandler) },
  { method: "POST", pattern: /^\/v1\/send_turn$/,             handler: withMiddleware(sendTurnHandler) },
  { method: "POST", pattern: /^\/v1\/cancel_turn$/,           handler: withMiddleware(cancelTurnHandler) },
  { method: "POST", pattern: /^\/v1\/resume_session$/,        handler: withMiddleware(resumeSessionHandler) },
  { method: "POST", pattern: /^\/v1\/pause$/,                 handler: withMiddleware(pauseHandler) },
  { method: "POST", pattern: /^\/v1\/resume$/,                handler: withMiddleware(resumeHandler) },
  { method: "GET",  pattern: /^\/v1\/status$/,                handler: withMiddleware(statusHandler) },
  { method: "GET",  pattern: /^\/v1\/sessions$/,              handler: withMiddleware(sessionsListHandler) },
  { method: "GET",  pattern: /^\/v1\/sessions\/(?<id>[^/]+)$/, handler: withMiddleware(sessionsShowHandler) },
  { method: "GET",  pattern: /^\/v1\/stats$/,                 handler: withMiddleware(statsHandler) },
  { method: "GET",  pattern: /^\/v1\/dead_letters$/,          handler: withMiddleware(deadLettersListHandler) },
  { method: "POST", pattern: /^\/v1\/dead_letters\/ack$/,     handler: withMiddleware(deadLettersAckHandler) },
];
