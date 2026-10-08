// src/worker/runtime.ts — the worker boundary.
//
// A worker is one `claude -p --input-format stream-json --output-format
// stream-json` child process per session. The daemon writes user messages to
// its stdin and reads newline-delimited JSON events from its stdout. Every
// event is normalised into a WorkerEvent and emitted on the daemon's bus, so
// the session layer (launcher, turn runner, closer, cancel, watchdog) never
// touches the process directly beyond the WorkerHandle below.

export type WorkerEvent =
  | { type: "init"; session_id: string; model?: string; tools?: string[]; mcp_servers?: Array<{ name: string; status: string }> }
  | { type: "assistant"; session_id: string; text: string; tool_uses: Array<{ id: string; name: string; input: unknown }> }
  | {
      type: "result";
      session_id: string;
      subtype: string;
      is_error: boolean;
      result: string;
      num_turns?: number;
      total_cost_usd?: number;
      duration_ms?: number;
      stop_reason?: string;
      /** e.g. `completed`, `aborted_streaming` (after an interrupt). */
      terminal_reason?: string;
      permission_denials?: unknown[];
    }
  | { type: "rate_limit"; session_id: string; status: string; rate_limit_type?: string; resets_at?: number; utilization?: number }
  | { type: "system"; session_id: string; subtype: string; raw: Record<string, unknown> }
  | { type: "stderr"; session_id: string; text: string }
  | { type: "exit"; session_id: string; code: number | null; signal: string | null };

export type ResultEvent = Extract<WorkerEvent, { type: "result" }>;

export interface SpawnOpts {
  sessionId: string;
  cwd: string;
  /** `new` starts a fresh conversation under `sessionId`; `resume` continues it. */
  mode: "new" | "resume";
  /** Path to a `.mcp.json` rendered for this session, passed via --mcp-config. */
  mcpConfigPath?: string;
}

export interface WorkerHandle {
  readonly sessionId: string;
  readonly pid: number | null;
  readonly alive: boolean;
  /** Resolves with the exit code once the process is gone. */
  readonly exited: Promise<number | null>;
  /** Text of every assistant message in the current (or last) turn. */
  readonly turnText: string;
  /** Queue a user turn. Claude processes queued messages sequentially. */
  send(prompt: string): void;
  /** Ask claude to end the running turn (control_request/interrupt). */
  interrupt(): void;
  /** Close stdin: claude finishes outstanding work and exits on its own. */
  end(): void;
  kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT"): void;
}

export interface WorkerRuntime {
  spawn(opts: SpawnOpts): WorkerHandle;
  get(sessionId: string): WorkerHandle | undefined;
  list(): WorkerHandle[];
}

/** Translate one raw stdout line from claude into a WorkerEvent, or null for
 *  lines the daemon does not care about. Exported for tests. */
export function parseClaudeLine(line: string, sessionId: string): WorkerEvent | null {
  let raw: any;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== "object") return null;

  switch (raw.type) {
    case "system":
      if (raw.subtype === "init") {
        return {
          type: "init",
          session_id: sessionId,
          model: typeof raw.model === "string" ? raw.model : undefined,
          tools: Array.isArray(raw.tools) ? raw.tools : undefined,
          mcp_servers: Array.isArray(raw.mcp_servers) ? raw.mcp_servers : undefined,
        };
      }
      return { type: "system", session_id: sessionId, subtype: String(raw.subtype ?? ""), raw };
    case "assistant": {
      const content = Array.isArray(raw.message?.content) ? raw.message.content : [];
      const text = content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("");
      const tool_uses = content
        .filter((b: any) => b?.type === "tool_use")
        .map((b: any) => ({ id: String(b.id ?? ""), name: String(b.name ?? ""), input: b.input }));
      return { type: "assistant", session_id: sessionId, text, tool_uses };
    }
    case "result":
      return {
        type: "result",
        session_id: sessionId,
        subtype: String(raw.subtype ?? ""),
        is_error: raw.is_error === true,
        result: typeof raw.result === "string" ? raw.result : "",
        num_turns: typeof raw.num_turns === "number" ? raw.num_turns : undefined,
        total_cost_usd: typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : undefined,
        duration_ms: typeof raw.duration_ms === "number" ? raw.duration_ms : undefined,
        stop_reason: typeof raw.stop_reason === "string" ? raw.stop_reason : undefined,
        terminal_reason: typeof raw.terminal_reason === "string" ? raw.terminal_reason : undefined,
        permission_denials: Array.isArray(raw.permission_denials) ? raw.permission_denials : undefined,
      };
    case "rate_limit_event": {
      const info = raw.rate_limit_info ?? {};
      const windows = info.unifiedWindows ?? {};
      const win = info.rateLimitType && windows[info.rateLimitType] ? windows[info.rateLimitType] : undefined;
      return {
        type: "rate_limit",
        session_id: sessionId,
        status: String(info.status ?? "unknown"),
        rate_limit_type: typeof info.rateLimitType === "string" ? info.rateLimitType : undefined,
        resets_at: typeof info.resetsAt === "number" ? info.resetsAt : undefined,
        utilization: typeof win?.utilization === "number" ? win.utilization : undefined,
      };
    }
    default:
      return null;
  }
}

/** Wire format for a user turn on claude's stdin. Exported for tests. */
export function userMessageLine(prompt: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
    parent_tool_use_id: null,
  }) + "\n";
}

/** Wire format for an interrupt. Exported for tests. */
export function interruptLine(requestId: string): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } }) + "\n";
}
