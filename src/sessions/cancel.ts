import type { TmuxAdapter } from "../tmux/adapter";
import type { EventBus } from "../events/bus";
import { getLastAssistantText } from "../transcript/reader";

export interface CancelOpts {
  tmux: TmuxAdapter;
  bus: EventBus;
  sessionId: string;
  tmuxName: string;
  transcriptPath: string;       // for partial-text extraction post-cancel
  escapeWaitMs?: number;        // default 3000
  ctrlcWaitMs?: number;         // default 2000
}

export interface CancelResult {
  cancelled: boolean;            // true iff a Stop event was observed
  escalatedToCtrlC: boolean;     // true if Escape alone wasn't enough
  partialText: string | null;
}

export async function cancelTurn(opts: CancelOpts): Promise<CancelResult> {
  const {
    tmux, bus, sessionId, tmuxName, transcriptPath,
    escapeWaitMs = 3000, ctrlcWaitMs = 2000,
  } = opts;

  let stopSeen = false;
  bus.subscribe((event) => {
    if (event.hook_event_name === "Stop" && event.session_id === sessionId) {
      stopSeen = true;
    }
  });

  await tmux.sendEscape(tmuxName);
  await new Promise(r => setTimeout(r, escapeWaitMs));

  let escalated = false;
  if (!stopSeen) {
    escalated = true;
    await tmux.sendCtrlC(tmuxName);
    await new Promise(r => setTimeout(r, ctrlcWaitMs));
  }

  return {
    cancelled: stopSeen,
    escalatedToCtrlC: escalated,
    partialText: getLastAssistantText(transcriptPath),
  };
}
