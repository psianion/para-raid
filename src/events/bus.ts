// src/events/bus.ts — DRIFT FROM MASTER PLAN: add session_end named channel
import type { HookEvent } from "../types";

type AnyHandler = (event: HookEvent) => void;
type SessionEndHandler = (event: HookEvent) => void;

export function createEventBus() {
  const anyHandlers: AnyHandler[] = [];
  const sessionEndHandlers: SessionEndHandler[] = [];
  return {
    subscribe(handler: AnyHandler): () => void {
      anyHandlers.push(handler);
      return () => {
        const i = anyHandlers.indexOf(handler);
        if (i !== -1) anyHandlers.splice(i, 1);
      };
    },
    onSessionEnd(handler: SessionEndHandler): () => void {
      sessionEndHandlers.push(handler);
      return () => {
        const i = sessionEndHandlers.indexOf(handler);
        if (i !== -1) sessionEndHandlers.splice(i, 1);
      };
    },
    emit(event: HookEvent) {
      for (const h of anyHandlers) h(event);
      if (event.hook_event_name === "SessionEnd") {
        for (const h of sessionEndHandlers) h(event);
      }
    },
    handlerCount(): number { return anyHandlers.length; },
  };
}
export type EventBus = ReturnType<typeof createEventBus>;
