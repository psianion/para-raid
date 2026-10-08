import { existsSync, accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../config/loader";
import { ADMIN_ID } from "../api/router";

export interface DoctorCheck {
  name: string;
  run: () => Promise<{ pass: boolean; msg: string }>;
}
export interface DoctorResult {
  allPass: boolean;
  checks: Array<{ name: string; pass: boolean; msg: string }>;
}

export async function runDoctorChecks(checks: DoctorCheck[]): Promise<DoctorResult> {
  const results: DoctorResult["checks"] = [];
  for (const c of checks) {
    const r = await c.run();
    results.push({ name: c.name, ...r });
  }
  return { allPass: results.every(r => r.pass), checks: results };
}

async function which(bin: string): Promise<string | null> {
  return Bun.which(bin);
}

async function exec(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()).trim();
  return { ok: (await p.exited) === 0, stdout: out };
}

/** data_dir under /tmp is wiped on reboot, taking the SQLite DB with it. */
export function isUnderTmp(p: string): boolean {
  return p === "/tmp" || p.startsWith("/tmp/");
}

/** Numeric semver compare on the `major.minor.patch` prefix: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The version gate: at least `min_version`, and — when the legacy exact
 *  allowlist is still present in a config — also a member of it. */
export function checkClaudeVersion(
  installed: string,
  cfg: { min_version: string; allowed_versions?: string[] },
): { pass: boolean; msg: string } {
  if (compareVersions(installed, cfg.min_version) < 0) {
    return { pass: false, msg: `claude=${installed} is older than min_version ${cfg.min_version} — run \`claude update\`` };
  }
  if (cfg.allowed_versions && !cfg.allowed_versions.includes(installed)) {
    return { pass: false, msg: `claude=${installed} NOT in allowed_versions ${JSON.stringify(cfg.allowed_versions)} — update the list or drop it to rely on min_version` };
  }
  return { pass: true, msg: `claude=${installed} (min ${cfg.min_version})` };
}

/** Interpret `claude auth status --json` so the daemon doesn't launch sessions
 *  that die at the login prompt. */
export function parseClaudeAuthStatus(stdout: string, exitOk: boolean): { pass: boolean; msg: string } {
  if (!exitOk) return { pass: false, msg: "claude auth status failed — run `claude auth login`" };
  let parsed: { loggedIn?: boolean; email?: string; authMethod?: string; subscriptionType?: string };
  try { parsed = JSON.parse(stdout); }
  catch { return { pass: false, msg: "could not parse claude auth status output" }; }
  if (parsed.loggedIn !== true) return { pass: false, msg: "not logged in — run `claude auth login`" };
  const who = parsed.email ?? parsed.authMethod ?? "logged in";
  const sub = parsed.subscriptionType ? ` (${parsed.subscriptionType})` : "";
  return { pass: true, msg: `${who}${sub}` };
}

/** Refuse-to-boot gate for the control-plane auth config — shared by the doctor
 *  check and the daemon boot gate. "none" is acceptable on the owner-only unix
 *  socket; "bearer" demands a real token; "mtls" is not implemented. */
export function checkAuthSecurity(
  auth: { mode: "none" | "bearer" | "mtls"; token?: string },
  adapters?: Record<string, { token?: string }>,
): { pass: boolean; msg: string } {
  if (auth.mode === "mtls") {
    return { pass: false, msg: "auth.mode 'mtls' is not implemented — use 'bearer' or 'none'" };
  }
  if (auth.mode === "bearer") {
    const token = auth.token ?? "";
    if (token.trim().length < 16) {
      return { pass: false, msg: "auth.mode 'bearer' needs auth.token of >= 16 chars — generate one (openssl rand -hex 32)" };
    }
    // Each adapter authenticates with its own token, so every per-adapter token
    // must be as strong as the global one, and no adapter may claim the admin
    // sentinel id (which would silently grant it daemon-wide access).
    for (const [id, cfg] of Object.entries(adapters ?? {})) {
      if (id === ADMIN_ID) {
        return { pass: false, msg: `adapters.${id} uses the reserved admin id '${ADMIN_ID}' — rename this adapter` };
      }
      if ((cfg.token ?? "").trim().length < 16) {
        return { pass: false, msg: `adapters.${id}.token must be >= 16 chars — generate one (openssl rand -hex 32)` };
      }
    }
    return { pass: true, msg: "bearer token configured" };
  }
  return { pass: true, msg: "auth disabled (none) — relies on the owner-only unix socket" };
}

/** Refuse-to-boot gate for webhook signing config. "none" is fine; "hmac" needs a
 *  real secret (the daemon signs outbound webhooks so adapters can verify them). */
export function checkSigningSecurity(signing: { mode: "none" | "hmac"; secret?: string }): { pass: boolean; msg: string } {
  if (signing.mode === "hmac") {
    const secret = signing.secret ?? "";
    if (secret.trim().length < 16) {
      return { pass: false, msg: "signing.mode 'hmac' needs signing.secret of >= 16 chars — generate one (openssl rand -hex 32)" };
    }
    return { pass: true, msg: "hmac signing secret configured" };
  }
  return { pass: true, msg: "webhook signing disabled (none)" };
}

/** Probe `claude auth status` — shared by the doctor check and the daemon boot gate. */
export async function checkClaudeLogin(): Promise<{ pass: boolean; msg: string }> {
  if (!(await which("claude"))) return { pass: false, msg: "claude not in PATH" };
  const r = await exec(["claude", "auth", "status", "--json"]);
  return parseClaudeAuthStatus(r.stdout, r.ok);
}

/** Installed claude version string, or null when it cannot be determined. */
export async function installedClaudeVersion(): Promise<string | null> {
  if (!(await which("claude"))) return null;
  const r = await exec(["claude", "--version"]);
  if (!r.ok) return null;
  return r.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

export function buildDoctorChecks(configPath: string): DoctorCheck[] {
  return [
    { name: "bun >= 1.3", run: async () => {
        const v = Bun.version;
        const [maj, min] = v.split(".").map(Number);
        return { pass: maj > 1 || (maj === 1 && min >= 3), msg: `bun=${v}` };
    }},
    { name: "claude available", run: async () => {
        const p = await which("claude");
        return { pass: !!p, msg: p ?? "not found in PATH" };
    }},
    { name: "claude headless stream-json", run: async () => {
        // Workers need `claude -p --input-format stream-json`; a build that
        // lacks the flag would reject every launch.
        if (!(await which("claude"))) return { pass: false, msg: "skipped: claude not in PATH" };
        const r = await exec(["claude", "--help"]);
        const ok = r.ok && r.stdout.includes("--input-format");
        return { pass: ok, msg: ok ? "supported" : "claude --help does not list --input-format — update claude" };
    }},
    { name: "ANTHROPIC_API_KEY unset", run: async () => {
        const set = !!process.env.ANTHROPIC_API_KEY;
        return { pass: !set, msg: set ? "SET (workers would bill the API, not your subscription)" : "unset" };
    }},
    { name: "config file exists", run: async () => {
        const exists = existsSync(configPath);
        return { pass: exists, msg: exists ? configPath : `missing: ${configPath}` };
    }},
    { name: "config parses + validates", run: async () => {
        if (!existsSync(configPath)) return { pass: false, msg: "skipped: no config" };
        try { loadConfig(configPath); return { pass: true, msg: "ok" }; }
        catch (e) { return { pass: false, msg: String(e) }; }
    }},
    { name: "claude version >= min", run: async () => {
        if (!existsSync(configPath)) return { pass: false, msg: "skipped: no config" };
        const cfg = loadConfig(configPath);
        const v = await installedClaudeVersion();
        if (!v) return { pass: false, msg: "could not read claude --version" };
        return checkClaudeVersion(v, cfg.claude);
    }},
    { name: "claude logged in", run: checkClaudeLogin },
    { name: "auth configured securely", run: async () => {
        if (!existsSync(configPath)) return { pass: false, msg: "skipped: no config" };
        return checkAuthSecurity(loadConfig(configPath).auth);
    }},
    { name: "signing configured securely", run: async () => {
        if (!existsSync(configPath)) return { pass: false, msg: "skipped: no config" };
        return checkSigningSecurity(loadConfig(configPath).signing);
    }},
    { name: "socket path writable", run: async () => {
        if (!existsSync(configPath)) return { pass: false, msg: "skipped: no config" };
        const cfg = loadConfig(configPath);
        const dir = dirname(cfg.daemon.socket_path);
        try { accessSync(dir, constants.W_OK); return { pass: true, msg: dir }; }
        catch { return { pass: false, msg: `not writable: ${dir}` }; }
    }},
    { name: "data_dir writable + durable", run: async () => {
        if (!existsSync(configPath)) return { pass: false, msg: "skipped: no config" };
        const dataDir = loadConfig(configPath).daemon.data_dir;
        if (isUnderTmp(dataDir)) return { pass: false, msg: `under /tmp (wiped on reboot): ${dataDir}` };
        let probe = dataDir; // walk up to the nearest dir that exists; createDb makes the rest
        while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
        try { accessSync(probe, constants.W_OK); return { pass: true, msg: dataDir }; }
        catch { return { pass: false, msg: `not writable: ${dataDir}` }; }
    }},
  ];
}
