// src/worker/claude.ts — the real WorkerRuntime: spawns `claude -p` per session.
import { randomUUID } from "node:crypto";
import type { EventBus } from "../events/bus";
import type { Logger } from "../logger";
import { interruptLine, parseClaudeLine, userMessageLine, type SpawnOpts, type WorkerHandle, type WorkerRuntime } from "./runtime";

export interface ClaudeRuntimeOpts {
  bus: EventBus;
  logger: Logger;
  /** Optional shell prep (config.claude.env_setup), e.g. `source ~/.nvm/nvm.sh`. */
  envSetup?: string;
  /** Optional model alias/name passed as --model. */
  model?: string;
  /** Extra args appended verbatim (config.claude.extra_args). */
  extraArgs?: string[];
}

/** The argv for one worker. Exported for tests. */
export function buildClaudeArgs(opts: SpawnOpts & { model?: string; extraArgs?: string[] }): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];
  if (opts.mode === "resume") args.push("--resume", opts.sessionId);
  else args.push("--session-id", opts.sessionId);
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
  if (opts.model) args.push("--model", opts.model);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Full spawn command. Without env_setup this is a direct `claude ...`; with
 *  it, bash runs the prep first and execs claude so the child we hold IS
 *  claude (signals and exit codes stay honest). Exported for tests. */
export function buildSpawnCommand(args: string[], envSetup?: string): string[] {
  const prep = envSetup?.trim();
  if (!prep) return ["claude", ...args];
  return ["bash", "-c", `${prep} && exec claude ${args.map(shellQuote).join(" ")}`];
}

export function createClaudeRuntime(opts: ClaudeRuntimeOpts): WorkerRuntime {
  const { bus, logger } = opts;
  const handles = new Map<string, WorkerHandle>();

  function spawn(sopts: SpawnOpts): WorkerHandle {
    const { sessionId } = sopts;
    const existing = handles.get(sessionId);
    if (existing?.alive) throw new Error(`worker for session ${sessionId} is already running`);

    const argv = buildSpawnCommand(buildClaudeArgs({ ...sopts, model: opts.model, extraArgs: opts.extraArgs }), opts.envSetup);
    // Workers bill the subscription, never the metered API: strip the key.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ANTHROPIC_API_KEY") env[k] = v;
    env.IS_SANDBOX = "1";

    const proc = Bun.spawn(argv, { cwd: sopts.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    logger.info("worker.spawn", { session_id: sessionId, pid: proc.pid, mode: sopts.mode, cwd: sopts.cwd });

    let alive = true;
    let turnText = "";
    let stdinOpen = true;

    const safeWrite = (line: string) => {
      if (!alive || !stdinOpen) throw new Error(`worker for session ${sessionId} is not accepting input`);
      proc.stdin.write(line);
      proc.stdin.flush();
    };

    const exited: Promise<number | null> = (async () => {
      const code = await proc.exited;
      alive = false;
      stdinOpen = false;
      const signal = proc.signalCode ?? null;
      logger.info("worker.exit", { session_id: sessionId, code, signal });
      bus.emit({ type: "exit", session_id: sessionId, code, signal });
      return code;
    })();

    (async () => {
      let buf = "";
      const dec = new TextDecoder();
      try {
        for await (const chunk of proc.stdout) {
          buf += dec.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            const ev = parseClaudeLine(line, sessionId);
            if (!ev) continue;
            if (ev.type === "init") turnText = "";
            else if (ev.type === "assistant") turnText += ev.text;
            bus.emit(ev);
          }
        }
      } catch (err) {
        logger.warn("worker.stdout_error", { session_id: sessionId, error: String(err) });
      }
    })();

    (async () => {
      const dec = new TextDecoder();
      try {
        for await (const chunk of proc.stderr) {
          const text = dec.decode(chunk).trim();
          if (!text) continue;
          logger.warn("worker.stderr", { session_id: sessionId, text: text.slice(0, 2000) });
          bus.emit({ type: "stderr", session_id: sessionId, text });
        }
      } catch { /* process gone */ }
    })();

    const handle: WorkerHandle = {
      sessionId,
      get pid() { return alive ? proc.pid : null; },
      get alive() { return alive; },
      exited,
      get turnText() { return turnText; },
      send(prompt) { turnText = ""; safeWrite(userMessageLine(prompt)); },
      interrupt() { safeWrite(interruptLine(randomUUID())); },
      end() {
        if (!alive || !stdinOpen) return;
        stdinOpen = false;
        try { proc.stdin.end(); } catch { /* already closed */ }
      },
      kill(signal = "SIGTERM") {
        if (!alive) return;
        try { proc.kill(signal); } catch { /* already gone */ }
      },
    };
    handles.set(sessionId, handle);
    return handle;
  }

  return {
    spawn,
    get(sessionId) { return handles.get(sessionId); },
    list() { return [...handles.values()].filter((h) => h.alive); },
  };
}
