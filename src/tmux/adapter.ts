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
export async function sendPrompt(tmux: TmuxAdapter, session: string, prompt: string): Promise<void> {
  if (prompt.includes("\n") || prompt.length > 8192) {
    await tmux.loadBufferAndPaste(session, prompt);
  } else {
    await tmux.sendKeysLiteral(session, prompt);
  }
  // Claude's TUI paste detection treats an Enter arriving in the same input
  // burst as the text as a literal newline, leaving the prompt unsubmitted.
  // A short gap makes the Enter read as a distinct human-like keypress.
  await new Promise((r) => setTimeout(r, 250));
  await tmux.sendEnter(session);
}
