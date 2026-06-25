import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, statSync, rmSync, writeFileSync, mkdirSync } from "fs";
import {
  provisionWorkdir,
  cleanupWorkdir,
  writeClaudeSettings,
  acceptClaudeTrust,
  claudeLaunchCommand,
} from "./index";

const BASE = "/tmp/pararaid-workdir-test";

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
});

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true });
});

test("provisionWorkdir creates 0700 dir", () => {
  const p = provisionWorkdir(BASE, "abc123");
  expect(existsSync(p)).toBe(true);
});

test("cleanupWorkdir removes the dir", () => {
  const p = provisionWorkdir(BASE, "abc123");
  expect(existsSync(p)).toBe(true);
  cleanupWorkdir(p);
  expect(existsSync(p)).toBe(false);
});

test("workdir is mode 0700", () => {
  const p = provisionWorkdir(BASE, "mode-test");
  const m = statSync(p).mode & 0o777;
  expect(m).toBe(0o700);
});

test("writeClaudeSettings creates valid hook config", () => {
  const p = provisionWorkdir(BASE, "settings-test");
  writeClaudeSettings(p, "/tmp/hooks.jsonl", "para-1");
  const j = JSON.parse(readFileSync(`${p}/.claude/settings.json`, "utf-8"));
  expect(j.hooks.Stop[0].matcher).toBe("");
  expect(j.hooks.Stop[0].hooks[0].type).toBe("command");
  expect(j.hooks.Stop[0].hooks[0].command).toContain("Stop");
  expect(j.hooks.Stop[0].hooks[0].command).toContain("para-1");
  expect(j.hooks.SessionEnd[0].hooks[0].command).toContain("SessionEnd");
  expect(j.hooks.PreToolUse[0].hooks[0].command).toContain("PreToolUse");
});

test("hook command produces parseable JSON when run", async () => {
  const p = provisionWorkdir(BASE, "shell-test");
  const events = `${BASE}/events.jsonl`;
  writeClaudeSettings(p, events, "para-2");
  const j = JSON.parse(readFileSync(`${p}/.claude/settings.json`, "utf-8"));
  const proc = Bun.spawn(["bash", "-c", j.hooks.SessionStart[0].hooks[0].command], { cwd: p });
  await proc.exited;
  const line = readFileSync(events, "utf-8").trim();
  const parsed = JSON.parse(line);
  expect(parsed.hook_event_name).toBe("SessionStart");
  expect(parsed.session_id).toBe("para-2");
});
test("hook command merges claude stdin payload (forwards last_assistant_message)", async () => {
  const p = provisionWorkdir(BASE, "shell-stdin");
  const events = `${BASE}/events-stdin.jsonl`;
  writeClaudeSettings(p, events, "para-3");
  const j = JSON.parse(readFileSync(`${p}/.claude/settings.json`, "utf-8"));
  const cmd = j.hooks.Stop[0].hooks[0].command;
  const wrapped = `echo '{"transcript_path":"/foo.jsonl","last_assistant_message":"hi there"}' | ${cmd}`;
  const proc = Bun.spawn(["bash", "-c", wrapped], { cwd: p });
  await proc.exited;
  const line = readFileSync(events, "utf-8").trim();
  const parsed = JSON.parse(line);
  expect(parsed.hook_event_name).toBe("Stop");
  expect(parsed.session_id).toBe("para-3");
  expect(parsed.last_assistant_message).toBe("hi there");
  expect(parsed.transcript_path).toBe("/foo.jsonl");
});

test("acceptClaudeTrust creates ~/.claude.json when missing", () => {
  const cfgPath = `${BASE}/claude.json`;
  acceptClaudeTrust("/tmp/some-workdir", cfgPath);
  const j = JSON.parse(readFileSync(cfgPath, "utf-8"));
  expect(j.projects["/tmp/some-workdir"].hasTrustDialogAccepted).toBe(true);
  expect(j.projects["/tmp/some-workdir"].mcpServers).toEqual({});
});

test("acceptClaudeTrust preserves existing config", () => {
  const cfgPath = `${BASE}/claude.json`;
  writeFileSync(cfgPath, JSON.stringify({
    userID: "u-1",
    projects: {
      "/other/path": { hasTrustDialogAccepted: true, mcpServers: { foo: { url: "x" } } },
    },
  }));
  acceptClaudeTrust("/tmp/new-workdir", cfgPath);
  const j = JSON.parse(readFileSync(cfgPath, "utf-8"));
  expect(j.userID).toBe("u-1");
  expect(j.projects["/other/path"].mcpServers.foo.url).toBe("x");
  expect(j.projects["/tmp/new-workdir"].hasTrustDialogAccepted).toBe(true);
});

test("acceptClaudeTrust forces hasTrustDialogAccepted=true even if previously false", () => {
  const cfgPath = `${BASE}/claude.json`;
  writeFileSync(cfgPath, JSON.stringify({
    projects: {
      "/tmp/wd": { hasTrustDialogAccepted: false, allowedTools: ["Bash"] },
    },
  }));
  acceptClaudeTrust("/tmp/wd", cfgPath);
  const j = JSON.parse(readFileSync(cfgPath, "utf-8"));
  expect(j.projects["/tmp/wd"].hasTrustDialogAccepted).toBe(true);
  expect(j.projects["/tmp/wd"].allowedTools).toEqual(["Bash"]);
});

test("claudeLaunchCommand has no env prep by default (claude on PATH)", () => {
  delete process.env.PARARAID_CLAUDE_ENV_SETUP;
  const cmd = claudeLaunchCommand();
  expect(cmd).toContain("exec claude --dangerously-skip-permissions");
  expect(cmd).not.toContain("nvm");
});

test("claudeLaunchCommand prepends configured env_setup", () => {
  process.env.PARARAID_CLAUDE_ENV_SETUP = "source /opt/node/env.sh";
  const cmd = claudeLaunchCommand();
  expect(cmd).toContain("source /opt/node/env.sh && exec claude");
  delete process.env.PARARAID_CLAUDE_ENV_SETUP;
});

test("claudeLaunchCommand passes through extra args", () => {
  const cmd = claudeLaunchCommand({ args: ["--print", "hello"] });
  expect(cmd).toContain("exec claude --print hello");
});

test("claudeLaunchCommand strips env vars when requested", () => {
  const cmd = claudeLaunchCommand({ args: ["--dangerously-skip-permissions"], unsetEnv: ["ANTHROPIC_API_KEY", "FOO"] });
  expect(cmd).toContain("exec env -u ANTHROPIC_API_KEY -u FOO claude --dangerously-skip-permissions");
});
