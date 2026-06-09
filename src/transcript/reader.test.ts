import { test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { getLastAssistantText, getNewContentSinceOffset } from "./reader";

const TMP = "/tmp/pararaid-w34-transcript";

beforeEach(() => { rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); });
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

test("extracts last assistant text from JSONL", () => {
  const lines = [
    JSON.stringify({ parentUuid: "p1", type: "user", message: { content: "hello" } }),
    JSON.stringify({ parentUuid: "p2", type: "assistant", message: { content: [{ type: "text", text: "hi there" }] } }),
    JSON.stringify({ parentUuid: "p3", type: "user", message: { content: "bye" } }),
    JSON.stringify({ parentUuid: "p4", type: "assistant", message: { content: [{ type: "thinking", text: "hmm" }, { type: "text", text: "goodbye!" }] } }),
  ];
  const path = join(TMP, "transcript.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  expect(getLastAssistantText(path)).toBe("goodbye!");
});

test("returns null for empty file", () => {
  const path = join(TMP, "empty.jsonl");
  writeFileSync(path, "");
  expect(getLastAssistantText(path)).toBeNull();
});

test("returns null for missing file", () => {
  expect(getLastAssistantText(join(TMP, "nope.jsonl"))).toBeNull();
});

test("getNewContentSinceOffset returns text after offset", () => {
  const path = join(TMP, "incr.jsonl");
  writeFileSync(path, "first\nsecond\n");
  const r = getNewContentSinceOffset(path, 6);
  expect(r.text).toBe("second\n");
  expect(r.newOffset).toBe(13);
});
