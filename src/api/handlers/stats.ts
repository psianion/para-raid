import { assertAdmin, type Handler } from "../router";
import { jsonResponse } from "../envelope";

interface SessionRow { id: string; adapter_id: string; cwd: string; status: string }

async function defaultPsRssKb(pid: number): Promise<number | null> {
  try {
    const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const n = Number(text.trim().split(/\s+/)[0]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function defaultDuBytes(path: string): Promise<number | null> {
  try {
    const proc = Bun.spawn(["du", "-sb", path], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const n = Number(text.trim().split(/\s+/)[0]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Test seam: tests overwrite these to skip Bun.spawn entirely.
export const __statsHooks: {
  psRssKb: (pid: number) => Promise<number | null>;
  duBytes: (path: string) => Promise<number | null>;
  pidFor: (tmuxSession: string) => Promise<number | null>;
} = {
  psRssKb: defaultPsRssKb,
  duBytes: defaultDuBytes,
  pidFor: async () => null, // production wiring: tmux pane pid lookup; stub returns null until wired
};

export const statsHandler: Handler = async (_req, ctx) => {
  assertAdmin(ctx);
  const rows = ctx.db.raw.query<SessionRow, []>(
    "SELECT id, adapter_id, cwd, status FROM sessions WHERE status IN ('live','launching','recovering')",
  ).all() as SessionRow[];

  const sessions: Array<{
    id: string;
    adapter_id: string;
    status: string;
    rss_mb: number | null;
    workdir_bytes: number | null;
  }> = [];

  let totalRssKb = 0;
  for (const r of rows) {
    const pid = await __statsHooks.pidFor(r.id);
    let rssKb: number | null = null;
    if (pid !== null) {
      rssKb = await __statsHooks.psRssKb(pid);
      if (rssKb !== null) totalRssKb += rssKb;
    }
    const workdirBytes = await __statsHooks.duBytes(r.cwd);
    sessions.push({
      id: r.id,
      adapter_id: r.adapter_id,
      status: r.status,
      rss_mb: rssKb !== null ? Math.round((rssKb / 1024) * 100) / 100 : null,
      workdir_bytes: workdirBytes,
    });
  }

  const daemonRssMb = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 100) / 100;
  const totalSessionRssMb = Math.round((totalRssKb / 1024) * 100) / 100;

  return jsonResponse(200, {
    sessions,
    daemon_rss_mb: daemonRssMb,
    total_session_rss_mb: totalSessionRssMb,
  });
};
