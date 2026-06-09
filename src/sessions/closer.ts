import { rmSync } from "fs";
import type { TmuxAdapter } from "../tmux/adapter";
import type { EventBus } from "../events/bus";

export interface CloseOpts {
  tmux: TmuxAdapter;
  bus: EventBus;
  sessionId: string;
  tmuxName: string;
  workdir: string | null;       // pass null for recycler (skip cleanup)
  timeoutMs?: number;           // default 10s for the SessionEnd wait
}

export async function closeSession(opts: CloseOpts): Promise<void> {
  const { tmux, bus, sessionId, tmuxName, workdir, timeoutMs = 10_000 } = opts;

  const sessionEnded = new Promise<void>((resolve) => {
    bus.onSessionEnd((event) => {
      if (event.session_id === sessionId) resolve();
    });
  });

  await tmux.sendKeysLiteral(tmuxName, "/exit");
  await tmux.sendEnter(tmuxName);

  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs));
  const race = await Promise.race([sessionEnded.then(() => "ok" as const), timeout]);

  if (race === "timeout") {
    await tmux.sendCtrlC(tmuxName);
    await new Promise(r => setTimeout(r, 100));
    await tmux.sendCtrlC(tmuxName);
    await new Promise(r => setTimeout(r, 200));
    if (await tmux.hasSession(tmuxName)) {
      await tmux.killSession(tmuxName);
    }
  }

  if (workdir !== null) {
    rmSync(workdir, { recursive: true, force: true });
  }
}
