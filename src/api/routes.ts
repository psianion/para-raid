import type { Route } from "./router";
import { withMiddleware } from "./serve";
import { openSessionHandler } from "./handlers/open-session";
import { closeSessionHandler } from "./handlers/close-session";
import { recycleSessionHandler } from "./handlers/recycle-session";
import { sendTurnHandler } from "./handlers/send-turn";
import { cancelTurnHandler } from "./handlers/cancel-turn";
import { resumeSessionHandler } from "./handlers/resume-session";

export const routes: Route[] = [
  { method: "POST", pattern: /^\/v1\/open_session$/,    params: [], handler: withMiddleware(openSessionHandler) },
  { method: "POST", pattern: /^\/v1\/close_session$/,   params: [], handler: withMiddleware(closeSessionHandler) },
  { method: "POST", pattern: /^\/v1\/recycle_session$/, params: [], handler: withMiddleware(recycleSessionHandler) },
];

routes.push(
  { method: "POST", pattern: /^\/v1\/send_turn$/,      params: [], handler: withMiddleware(sendTurnHandler) },
  { method: "POST", pattern: /^\/v1\/cancel_turn$/,    params: [], handler: withMiddleware(cancelTurnHandler) },
  { method: "POST", pattern: /^\/v1\/resume_session$/, params: [], handler: withMiddleware(resumeSessionHandler) },
);

import { pauseHandler }            from "./handlers/pause";
import { resumeHandler }           from "./handlers/resume";
import { statusHandler }           from "./handlers/status";
import { sessionsListHandler }     from "./handlers/sessions-list";
import { sessionsShowHandler }     from "./handlers/sessions-show";
import { statsHandler }            from "./handlers/stats";
import { deadLettersListHandler, deadLettersAckHandler } from "./handlers/dead-letters";

routes.push(
  { method: "POST", pattern: /^\/v1\/pause$/,                  params: [],     handler: withMiddleware(pauseHandler) },
  { method: "POST", pattern: /^\/v1\/resume$/,                 params: [],     handler: withMiddleware(resumeHandler) },
  { method: "GET",  pattern: /^\/v1\/status$/,                 params: [],     handler: withMiddleware(statusHandler) },
  { method: "GET",  pattern: /^\/v1\/sessions$/,               params: [],     handler: withMiddleware(sessionsListHandler) },
  { method: "GET",  pattern: /^\/v1\/sessions\/(?<id>[^/]+)$/, params: ["id"], handler: withMiddleware(sessionsShowHandler) },
  { method: "GET",  pattern: /^\/v1\/stats$/,                  params: [],     handler: withMiddleware(statsHandler) },
  { method: "GET",  pattern: /^\/v1\/dead_letters$/,           params: [],     handler: withMiddleware(deadLettersListHandler) },
  { method: "POST", pattern: /^\/v1\/dead_letters\/ack$/,      params: [],     handler: withMiddleware(deadLettersAckHandler) },
);
