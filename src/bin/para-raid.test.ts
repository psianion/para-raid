import { test, expect } from "bun:test";
import { parseArgs, formatTable, formatJson, authHeader } from "./para-raid";

test("authHeader emits a Bearer header only when a token is set", () => {
  expect(authHeader("")).toEqual({});
  expect(authHeader("abc123")).toEqual({ Authorization: "Bearer abc123" });
});

test("parseArgs handles subcommand + positional + named flags", () => {
  expect(parseArgs(["status"])).toEqual({ subcommand: "status", positional: [], flags: {} });
  expect(parseArgs(["sessions", "show", "abc-123"])).toEqual({
    subcommand: "sessions", positional: ["show", "abc-123"], flags: {},
  });
  expect(parseArgs(["status", "--json"])).toEqual({
    subcommand: "status", positional: [], flags: { json: true },
  });
  expect(parseArgs(["open-session", "--adapter-id", "test", "--prompt", "say hi"])).toEqual({
    subcommand: "open-session", positional: [],
    flags: { "adapter-id": "test", prompt: "say hi" },
  });
});

test("parseArgs treats --foo=bar same as --foo bar", () => {
  expect(parseArgs(["x", "--key=value"])).toEqual({
    subcommand: "x", positional: [], flags: { key: "value" },
  });
});

test("formatJson is stable JSON.stringify with 2-space indent", () => {
  expect(formatJson({ a: 1, b: [2, 3] })).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
});

test("formatTable renders header + rows aligned", () => {
  const out = formatTable(["id", "state"], [["a", "live"], ["bb", "dead"]]);
  expect(out.split("\n")[0]).toMatch(/^id\s+state$/);
  expect(out.split("\n")[1]).toMatch(/^a\s+live$/);
  expect(out.split("\n")[2]).toMatch(/^bb\s+dead$/);
});
