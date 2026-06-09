// src/bin/setup.ts — `para-raid setup` / `para-raid up`: the one-command gateway.
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { buildDoctorChecks, runDoctorChecks, checkClaudeLogin } from "./doctor";

/** A 64-char hex secret (32 random bytes) for the bearer token / signing key. */
export function genSecret(): string {
  return randomBytes(32).toString("hex");
}

/** Turn config.example.toml into a ready config: pin the claude version, and in
 *  the [auth]/[signing] sections only, flip mode and inject the secrets. Comments
 *  and every other section (incl. [adapters]) are preserved verbatim. */
export function renderConfig(example: string, opts: { version: string; token: string; secret: string }): string {
  let section = "";
  return example.split("\n").map((line) => {
    const m = line.match(/^\[([^\]]+)\]/);
    if (m) { section = m[1]; return line; }
    if (/^allowed_versions\s*=/.test(line)) return `allowed_versions = ["${opts.version}"]`;
    if (section === "auth") {
      if (/^mode\s*=\s*"none"/.test(line)) return line.replace('"none"', '"bearer"');
      if (/^token\s*=\s*""/.test(line)) return line.replace('""', `"${opts.token}"`);
    } else if (section === "signing") {
      if (/^mode\s*=\s*"none"/.test(line)) return line.replace('"none"', '"hmac"');
      if (/^secret\s*=\s*""/.test(line)) return line.replace('""', `"${opts.secret}"`);
    }
    return line;
  }).join("\n");
}

/** The systemd --user unit, with the same hardening as the old install.sh. */
export function renderSystemdUnit(opts: { configPath: string; repoDir: string; bunPath: string; home: string }): string {
  return `[Unit]
Description=para-raid daemon
After=network-online.target

[Service]
Type=simple
Environment=PARARAID_CONFIG=${opts.configPath}
Environment=PATH=${opts.home}/.bun/bin:/usr/local/bin:/usr/bin:/bin
UnsetEnvironment=ANTHROPIC_API_KEY
ExecStart=${opts.bunPath} run ${opts.repoDir}/src/daemon.ts
Restart=on-failure
RestartSec=2
MemoryHigh=85%
MemoryMax=95%

[Install]
WantedBy=default.target
`;
}

// --- small process helpers (orchestration glue) ---
async function which(bin: string): Promise<string | null> {
  const p = Bun.spawn(["which", bin], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()).trim();
  return (await p.exited) === 0 && out ? out : null;
}
async function run(args: string[]): Promise<number> {
  const p = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  return p.exited;
}
async function claudeVersion(): Promise<string> {
  const p = Bun.spawn(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()).trim();
  return (await p.exited) === 0 ? (out.match(/\d+\.\d+\.\d+/)?.[0] ?? "") : "";
}
function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "para-raid");
}
function unitPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user/para-raid.service");
}

/** `para-raid setup` — configure this box. Returns a process exit code. */
export async function runSetup(opts: { repoDir: string }): Promise<number> {
  const say = (s: string) => console.log(`\x1b[1m==>\x1b[0m ${s}`);
  const die = (s: string) => { console.error(`\x1b[31merror:\x1b[0m ${s}`); };

  for (const bin of ["bun", "tmux", "jq", "python3", "claude"]) {
    if (!(await which(bin))) { die(`missing prerequisite: ${bin} (install it and re-run)`); return 1; }
  }
  if (process.env.ANTHROPIC_API_KEY) { die("ANTHROPIC_API_KEY is set — unset it so workers use your Claude subscription, not the metered API"); return 1; }
  const login = await checkClaudeLogin();
  if (!login.pass) { die(`claude is not logged in — run 'claude auth login', then re-run setup (${login.msg})`); return 1; }

  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.toml");
  if (existsSync(configPath)) {
    say(`config exists, leaving it untouched: ${configPath}`);
  } else {
    const version = await claudeVersion();
    const out = renderConfig(readFileSync(join(opts.repoDir, "config.example.toml"), "utf8"), { version, token: genSecret(), secret: genSecret() });
    writeFileSync(configPath, out);
    chmodSync(configPath, 0o600);
    say(`wrote ${configPath} — pinned claude ${version}, bearer auth + hmac signing enabled (keep it private)`);
  }
  const bundlesPath = join(dir, "mcp-bundles.toml");
  if (!existsSync(bundlesPath)) { copyFileSync(join(opts.repoDir, "mcp-bundles.example.toml"), bundlesPath); say(`wrote ${bundlesPath}`); }

  if (await which("systemctl")) {
    const ud = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user");
    mkdirSync(ud, { recursive: true });
    writeFileSync(join(ud, "para-raid.service"), renderSystemdUnit({ configPath, repoDir: opts.repoDir, bunPath: (await which("bun")) ?? "bun", home: homedir() }));
    await run(["systemctl", "--user", "daemon-reload"]);
    say("installed systemd --user unit");
  } else {
    say("systemctl not found — you'll start it in the foreground with `para-raid up`");
  }

  console.log("\nchecks:");
  const result = await runDoctorChecks(buildDoctorChecks(configPath));
  for (const c of result.checks) console.log(`  ${c.pass ? "✓" : "✗"} ${c.name.padEnd(30)} ${c.msg}`);
  console.log(result.allPass ? "\nsetup complete. start it:  para-raid up" : "\nconfig written, but some checks failed — fix the ✗ above, then `para-raid doctor`");
  return result.allPass ? 0 : 1;
}

/** `para-raid up` — start the daemon (systemd --user if available, else foreground). */
export async function runUp(opts: { repoDir: string }): Promise<void> {
  if ((await which("systemctl")) && existsSync(unitPath())) {
    const code = await run(["systemctl", "--user", "enable", "--now", "para-raid"]);
    if (code === 0) console.log("para-raid started via systemd --user. Check it: para-raid status\n(survive logout with: loginctl enable-linger \"$USER\")");
    else console.error("systemctl failed — try `para-raid daemon` to run in the foreground");
    process.exit(code);
  }
  console.log("no systemd unit found — running in the foreground (Ctrl-C to stop)…");
  await import("../daemon");
}
