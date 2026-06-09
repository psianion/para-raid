import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<string>();

export function getRequestId(): string | undefined {
  return als.getStore();
}

export function withRequestId<T>(id: string, fn: () => T): T {
  return als.run(id, fn);
}

interface LogSink {
  write: (line: string) => void;
  isTTY: boolean;
}

export interface Logger {
  info(event: string, data: Record<string, unknown>): void;
  warn(event: string, data: Record<string, unknown>): void;
  error(event: string, data: Record<string, unknown>): void;
}

export function createLogger(
  sink: LogSink = {
    write: (l) => process.stdout.write(l + "\n"),
    isTTY: process.stdout.isTTY ?? false,
  },
): Logger {
  function emit(level: string, event: string, data: Record<string, unknown>) {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event,
      ...data,
    };
    const rid = getRequestId();
    if (rid) entry.request_id = rid;

    if (sink.isTTY) {
      const color = level === "error" ? "\x1b[31m" : level === "warn" ? "\x1b[33m" : "\x1b[36m";
      sink.write(`${color}[${level}]\x1b[0m ${event} ${JSON.stringify(data)}`);
    } else {
      sink.write(JSON.stringify(entry));
    }
  }

  return {
    info: (event, data) => emit("info", event, data),
    warn: (event, data) => emit("warn", event, data),
    error: (event, data) => emit("error", event, data),
  };
}
