import { existsSync, readdirSync, statSync } from "node:fs";

/**
 * Locate the most recent transcript JSONL file Claude writes for a given
 * working directory. Lifted from `scripts/wave-3-4-prod-smoke.ts`.
 *
 * Claude encodes a workdir as `-` + the absolute path with `/` -> `-`
 * and stores transcripts under `~/.claude/projects/<encoded>/<uuid>.jsonl`.
 * Multiple sessions in the same workdir produce multiple JSONL files;
 * we return whichever was most recently modified.
 *
 * Returns `null` if the directory or any matching file is missing.
 */
export function findTranscriptForCwd(cwd: string): string | null {
  const enc = "-" + cwd.replace(/^\//, "").replace(/\//g, "-");
  const home = process.env.HOME ?? "";
  const dir = `${home}/.claude/projects/${enc}`;
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return null;
  files.sort((a, b) => statSync(`${dir}/${b}`).mtimeMs - statSync(`${dir}/${a}`).mtimeMs);
  return `${dir}/${files[0]}`;
}
