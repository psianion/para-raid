import type { TmuxAdapter } from "../tmux/adapter";
import type { DispatchJob } from "../types";

export interface DispatcherOpts {
  maxConcurrentTurns: number;
  tmux: TmuxAdapter;
  onDispatch: (job: DispatchJob) => Promise<string>;
}

interface QueueEntry {
  job: DispatchJob;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

export function createDispatcher(opts: DispatcherOpts) {
  const { maxConcurrentTurns, onDispatch } = opts;
  const queue: QueueEntry[] = [];
  let active = 0;
  const activePerSession = new Set<string>();
  let stopped = false;

  function drain() {
    while (!stopped && queue.length > 0 && active < maxConcurrentTurns) {
      const idx = queue.findIndex(q => !activePerSession.has(q.job.session_id));
      if (idx === -1) break;
      const entry = queue.splice(idx, 1)[0];
      active++;
      activePerSession.add(entry.job.session_id);

      (async () => {
        try {
          const result = await onDispatch(entry.job);
          entry.resolve(result);
        } catch (err) {
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        } finally {
          active--;
          activePerSession.delete(entry.job.session_id);
          drain();
        }
      })();
    }
  }

  return {
    enqueue(job: DispatchJob): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        queue.push({ job, resolve, reject });
        drain();
      });
    },
    get pendingCount() { return queue.length; },
    get activeCount() { return active; },
    stop() { stopped = true; },
  };
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
