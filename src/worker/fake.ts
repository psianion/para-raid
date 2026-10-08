// src/worker/fake.ts — scripted WorkerRuntime for tests. Records every call and
// lets a test emit the events a real claude would produce.
import type { EventBus } from "../events/bus";
import type { ResultEvent, SpawnOpts, WorkerEvent, WorkerHandle, WorkerRuntime } from "./runtime";

export interface FakeWorker extends WorkerHandle {
  opts: SpawnOpts;
  sent: string[];
  interrupts: number;
  ended: boolean;
  killed: string[];
  /** Simulate the process exiting. */
  exit(code?: number | null, signal?: string | null): void;
}

export interface FakeRuntime extends WorkerRuntime {
  spawns: SpawnOpts[];
  workers: Map<string, FakeWorker>;
  /** Make the next spawn() throw (e.g. claude binary missing). */
  failNextSpawn: Error | null;
  /** Make workers exit right after spawn with this code (launch failure). */
  exitOnSpawn: number | null;
  /** When true, `end()` makes the worker exit on the next tick like a real claude. */
  exitOnEnd: boolean;
  emitInit(sessionId: string): void;
  emitAssistant(sessionId: string, text: string, toolUses?: Array<{ id: string; name: string; input: unknown }>): void;
  emitResult(sessionId: string, result: string, extra?: Partial<ResultEvent>): void;
  emitRateLimit(sessionId: string, status: string, extra?: Partial<Extract<WorkerEvent, { type: "rate_limit" }>>): void;
  emitExit(sessionId: string, code?: number | null): void;
}

export function createFakeRuntime(bus: EventBus): FakeRuntime {
  const spawns: SpawnOpts[] = [];
  const workers = new Map<string, FakeWorker>();

  const fake: FakeRuntime = {
    spawns,
    workers,
    failNextSpawn: null,
    exitOnSpawn: null,
    exitOnEnd: true,

    spawn(opts) {
      if (fake.failNextSpawn) { const e = fake.failNextSpawn; fake.failNextSpawn = null; throw e; }
      const existing = workers.get(opts.sessionId);
      if (existing?.alive) throw new Error(`worker for session ${opts.sessionId} is already running`);
      spawns.push(opts);
      let alive = true;
      let turnText = "";
      let resolveExit!: (code: number | null) => void;
      const exited = new Promise<number | null>((r) => { resolveExit = r; });
      const w: FakeWorker = {
        opts,
        sessionId: opts.sessionId,
        sent: [],
        interrupts: 0,
        ended: false,
        killed: [],
        get pid() { return alive ? 12345 : null; },
        get alive() { return alive; },
        exited,
        get turnText() { return turnText; },
        send(prompt) {
          if (!alive || w.ended) throw new Error(`worker for session ${opts.sessionId} is not accepting input`);
          turnText = "";
          w.sent.push(prompt);
        },
        interrupt() { w.interrupts++; },
        end() {
          if (w.ended) return;
          w.ended = true;
          if (fake.exitOnEnd) setTimeout(() => w.exit(0), 0);
        },
        kill(signal = "SIGTERM") {
          w.killed.push(signal);
          if (signal === "SIGKILL" || signal === "SIGTERM") w.exit(signal === "SIGKILL" ? 137 : 143, signal);
        },
        exit(code = 0, signal = null) {
          if (!alive) return;
          alive = false;
          resolveExit(code);
          bus.emit({ type: "exit", session_id: opts.sessionId, code, signal });
        },
      };
      bus.subscribe((ev) => {
        if (ev.session_id !== opts.sessionId) return;
        if (ev.type === "init") turnText = "";
        else if (ev.type === "assistant") turnText += ev.text;
      });
      workers.set(opts.sessionId, w);
      if (fake.exitOnSpawn !== null) {
        const code = fake.exitOnSpawn;
        setTimeout(() => w.exit(code), 0);
      }
      return w;
    },
    get(sessionId) { return workers.get(sessionId); },
    list() { return [...workers.values()].filter((w) => w.alive); },

    emitInit(sessionId) { bus.emit({ type: "init", session_id: sessionId }); },
    emitAssistant(sessionId, text, toolUses = []) { bus.emit({ type: "assistant", session_id: sessionId, text, tool_uses: toolUses }); },
    emitResult(sessionId, result, extra = {}) {
      bus.emit({ type: "result", session_id: sessionId, subtype: "success", is_error: false, result, ...extra });
    },
    emitRateLimit(sessionId, status, extra = {}) { bus.emit({ type: "rate_limit", session_id: sessionId, status, ...extra }); },
    emitExit(sessionId, code = 0) { workers.get(sessionId)?.exit(code); },
  };
  return fake;
}
