import { mkdirSync, rmSync } from "fs";
import { join } from "path";

/** One private directory per session: claude's cwd, and where the rendered
 *  `.mcp.json` lives. Owner-only because a worker runs with your shell and
 *  your `~/.claude` credential. */
export function provisionWorkdir(baseDir: string, sessionId: string): string {
  const path = join(baseDir, "workdirs", sessionId);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export function cleanupWorkdir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
