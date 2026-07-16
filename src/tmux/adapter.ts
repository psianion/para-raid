// src/tmux/adapter.ts
export interface TmuxAdapter {
  newSession(name: string, cwd: string, command: string): Promise<void>;
  hasSession(name: string): Promise<boolean>;
  sendKeysLiteral(name: string, text: string): Promise<void>;
  loadBufferAndPaste(name: string, text: string): Promise<void>;
  sendEnter(name: string): Promise<void>;
  sendEscape(name: string): Promise<void>;
  sendCtrlC(name: string): Promise<void>;
  killSession(name: string): Promise<void>;
  listPanePid(name: string): Promise<number | null>;
  capturePaneOutput(name: string, lines?: number): Promise<string>;
}

/**
 * Send a prompt to a tmux session, choosing the right transport.
 * Uses paste-buffer if prompt contains newlines or is >8KB.
 * Reason: Claude's interactive prompt submits on first \n.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when the pane's input line (the last `❯` line) still holds the prompt. */
export function promptStillPending(pane: string, probe: string): boolean {
  const lines = pane.split("\n").map((l) => l.trim());
  const inputLine = lines.filter((l) => l.startsWith("❯")).at(-1);
  return inputLine !== undefined && inputLine.includes(probe);
}

export async function sendPrompt(tmux: TmuxAdapter, session: string, prompt: string): Promise<void> {
  if (prompt.includes("\n") || prompt.length > 8192) {
    await tmux.loadBufferAndPaste(session, prompt);
  } else {
    await tmux.sendKeysLiteral(session, prompt);
  }
  // Claude's TUI paste detection treats an Enter arriving too close to the
  // text as a literal newline, leaving the prompt unsubmitted — and the
  // threshold varies by machine. So: send Enter, VERIFY the input line
  // actually cleared, and retry with growing gaps until it did.
  const probe = prompt.split("\n")[0]!.slice(0, 40);
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(250 + attempt * 750);
    await tmux.sendEnter(session);
    await sleep(400);
    const pane = await tmux.capturePaneOutput(session, 20).catch(() => "");
    if (!promptStillPending(pane, probe)) return;
  }
  // Out of retries: leave it — the turn's Stop timeout owns failure reporting.
}
