import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { findTranscriptForCwd } from "./locator";

const TMP = "/tmp/pararaid-w56-locator";
const ORIG_HOME = process.env.HOME;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  process.env.HOME = TMP;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
});

test("findTranscriptForCwd returns most-recently-modified .jsonl in the encoded dir", () => {
  const cwd = "/var/data/para-raid/workdirs/abc";
  const enc = "-var-data-para-raid-workdirs-abc";
  const dir = `${TMP}/.claude/projects/${enc}`;
  mkdirSync(dir, { recursive: true });

  const older = `${dir}/older-uuid.jsonl`;
  const newer = `${dir}/newer-uuid.jsonl`;
  writeFileSync(older, "{}\n");
  writeFileSync(newer, "{}\n");

  // Force older.mtime to be 60 s in the past so the sort is unambiguous.
  const past = (Date.now() - 60_000) / 1000;
  utimesSync(older, past, past);

  const found = findTranscriptForCwd(cwd);
  expect(found).toBe(newer);
});

test("findTranscriptForCwd returns null when the encoded dir is missing", () => {
  expect(findTranscriptForCwd("/no/such/path")).toBeNull();
});

test("findTranscriptForCwd returns null when the encoded dir has no .jsonl files", () => {
  const cwd = "/tmp/empty-cwd";
  const enc = "-tmp-empty-cwd";
  const dir = `${TMP}/.claude/projects/${enc}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/notes.txt`, "ignored\n");
  expect(findTranscriptForCwd(cwd)).toBeNull();
});
