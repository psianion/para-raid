// src/tmux/adapter.ts
export interface TmuxAdapter {
  newSession(name: string, cwd: string, command: string): Promise<void>;
  hasSession(name: string): Promise<boolean>;
  sendKeys(name: string, text: string): Promise<void>;
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
  await tmux.sendEnter(session);
}
