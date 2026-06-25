import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export function provisionWorkdir(baseDir: string, adapterRef: string): string {
  const path = join(baseDir, "workdirs", adapterRef);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

export function cleanupWorkdir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/**
 * Writes .claude/settings.json with hooks that append JSON lines to a shared
 * hook-events.jsonl. Each line carries the para-raid session id so the tailer
 * can demux multi-session output.
 *
 * Hook entries follow Claude Code's `{matcher, hooks: [{type, command}]}` shape
 * — empty matcher matches all triggers. Master plan and Wave 2 session plan
 * both used a flatter shape that Claude rejects with "Expected array" — fixed
 * here after the Wave 2 prod-smoke surfaced the schema error.
 */
export function writeClaudeSettings(workdir: string, hookEventsPath: string, paraSessionId: string): void {
  mkdirSync(join(workdir, ".claude"), { recursive: true });
  // Hook command: read claude's hook payload from stdin (JSON, may carry
  // last_assistant_message, transcript_path, etc.), merge our hardcoded
  // hook_event_name + session_id + cwd + ts, append one line to the events
  // file. Empty stdin (some local test paths) falls back to {} so the line
  // is always well-formed.
  const py = `import json,sys,os,time;d=sys.stdin.read();o=json.loads(d) if d.strip() else {};o["hook_event_name"]=sys.argv[1];o["session_id"]=sys.argv[2];o["cwd"]=os.environ.get("PWD","");o["ts"]=int(time.time()*1000);open(sys.argv[3],"a").write(json.dumps(o)+chr(10))`;
  const cmd = (eventName: string) =>
    `python3 -c '${py}' ${JSON.stringify(eventName)} ${JSON.stringify(paraSessionId)} ${JSON.stringify(hookEventsPath)}`;

  const entry = (eventName: string) => [
    { matcher: "", hooks: [{ type: "command", command: cmd(eventName) }] },
  ];

  const settings = {
    hooks: {
      SessionStart: entry("SessionStart"),
      Stop:         entry("Stop"),
      SessionEnd:   entry("SessionEnd"),
      UserPromptSubmit: entry("UserPromptSubmit"),
      PreToolUse:   entry("PreToolUse"),
    },
  };
  writeFileSync(join(workdir, ".claude/settings.json"), JSON.stringify(settings, null, 2));
}

const MINIMAL_PROJECT_ENTRY = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: true,
  projectOnboardingSeenCount: 0,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
} as const;

/**
 * Pre-seeds claude's `~/.claude.json` so the "trust this folder?" dialog is
 * skipped for `workdir`. `--dangerously-skip-permissions` does NOT bypass that
 * dialog; without pre-seeding, the launcher must send Enter via tmux before
 * the SessionStart hook will fire.
 *
 * Atomic via temp-file + rename. Reads existing config to preserve sibling
 * fields (other projects, top-level user state). If `~/.claude.json` does not
 * exist, creates it with just the projects map.
 *
 * NOTE: this mutates per-user state shared with the user's interactive claude
 * sessions. Multiple concurrent provisioners can race; if that becomes a
 * problem, wrap the read-modify-write in a flock.
 */
export function acceptClaudeTrust(workdir: string, claudeJsonPath: string = join(homedir(), ".claude.json")): void {
  const cfg: Record<string, unknown> = existsSync(claudeJsonPath)
    ? JSON.parse(readFileSync(claudeJsonPath, "utf-8"))
    : {};

  const projects = (cfg.projects as Record<string, Record<string, unknown>> | undefined) ?? {};
  const existing = projects[workdir] ?? {};
  projects[workdir] = { ...MINIMAL_PROJECT_ENTRY, ...existing, hasTrustDialogAccepted: true };
  cfg.projects = projects;

  const tmp = `${claudeJsonPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, claudeJsonPath);
}

/**
 * Returns the shell command for `tmux new-session ... <cmd>` that launches
 * claude with nvm sourced. The nvm-installed `claude` binary is not on the
 * non-interactive ssh PATH, so a direct `claude ...` invocation fails with
 * "command not found". This wrapper optionally runs a configured prep step
 * (config.claude.env_setup) first and uses `exec` so the bash process is
 * replaced (claude becomes the pane's PID 1).
 *
 * Args are space-joined and NOT escaped — caller pre-quotes anything sensitive.
 */
export function claudeLaunchCommand(opts: { args?: string[]; unsetEnv?: string[] } = {}): string {
  const args = opts.args ?? ["--dangerously-skip-permissions"];
  const unset = opts.unsetEnv?.length ? `env ${opts.unsetEnv.map(k => `-u ${k}`).join(" ")} ` : "";
  // Optional shell prep sourced before exec (e.g. "source ~/.nvm/nvm.sh" for
  // nvm installs whose claude isn't on the non-interactive PATH). The daemon
  // sets this from config.claude.env_setup at boot; empty by default so a
  // claude already on PATH (apt/volta/asdf/global) just works.
  const envSetup = process.env.PARARAID_CLAUDE_ENV_SETUP?.trim();
  const prep = envSetup ? `${envSetup} && ` : "";
  return `bash -c '${prep}exec ${unset}claude ${args.join(" ")}'`;
}
