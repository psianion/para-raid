// src/events/bus.ts — in-process fan-out of WorkerEvents.
import type { WorkerEvent } from "../worker/runtime";

type Handler = (event: WorkerEvent) => void;

export function createEventBus() {
  const handlers: Handler[] = [];
  function subscribe(handler: Handler): () => void {
    handlers.push(handler);
    return () => {
      const i = handlers.indexOf(handler);
      if (i !== -1) handlers.splice(i, 1);
    };
  }
  return {
    subscribe,
    /** Subscribe to one session's exit only. */
    onExit(sessionId: string, handler: (event: Extract<WorkerEvent, { type: "exit" }>) => void): () => void {
      return subscribe((ev) => {
        if (ev.type === "exit" && ev.session_id === sessionId) handler(ev);
      });
    },
    emit(event: WorkerEvent) {
      // Snapshot: a handler may unsubscribe itself (or others) while we iterate.
      for (const h of [...handlers]) h(event);
    },
    handlerCount(): number { return handlers.length; },
  };
}
export type EventBus = ReturnType<typeof createEventBus>;
