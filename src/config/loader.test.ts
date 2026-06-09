import { test, expect } from "bun:test";
import { loadConfig } from "./loader";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const TMP = "/tmp/pararaid-config-test";

function writeConfig(
  extraDaemon: string,
  observability = `ram_warn_pct = 75
ram_refuse_pct = 90
stats_interval_ms = 30000`,
): string {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const p = join(TMP, "config.toml");
  writeFileSync(p, `
[daemon]
${extraDaemon}

[claude]
allowed_versions = ["2.1.109"]

[concurrency]
max_concurrent_turns = 3
max_total_sessions = 10

[recovery]
grace_window_ms = 600000

[publisher]
retry_window_ms = 600000
backoff_ms = [1000, 2000, 4000]

[limit]
warning_regex = "quota"

[observability]
${observability}

[auth]
mode = "none"

[signing]
mode = "none"
`);
  return p;
}

test("loadConfig rejects ram_warn_pct >= ram_refuse_pct (hysteresis would collapse)", () => {
  const p = writeConfig(
    `socket_path = "/tmp/x.sock"\ndata_dir = "/tmp/d"`,
    `ram_warn_pct = 90\nram_refuse_pct = 80\nstats_interval_ms = 30000`,
  );
  expect(() => loadConfig(p)).toThrow();
});

test("expands ~ and $ENV in daemon paths", () => {
  process.env.PARARAID_TEST_RT = "/run/user/1000";
  const p = writeConfig(
    `socket_path = "$PARARAID_TEST_RT/para-raid.sock"\ndata_dir = "~/.local/state/para-raid"`
  );
  const config = loadConfig(p);
  expect(config.daemon.socket_path).toBe("/run/user/1000/para-raid.sock");
  expect(config.daemon.data_dir).toBe(join(homedir(), ".local/state/para-raid"));
});

test("turn_timeout_ms defaults to 5 min when omitted", () => {
  const p = writeConfig(`socket_path = "/tmp/s.sock"\ndata_dir = "/tmp/d"`);
  expect(loadConfig(p).concurrency.turn_timeout_ms).toBe(300000);
});

test("throws a clear error when a referenced env var is unset", () => {
  delete process.env.PARARAID_TEST_MISSING;
  const p = writeConfig(
    `socket_path = "$PARARAID_TEST_MISSING/x.sock"\ndata_dir = "/tmp/d"`
  );
  expect(() => loadConfig(p)).toThrow(/PARARAID_TEST_MISSING/);
});

test("loads and validates a minimal config", () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, "config.toml"), `
[daemon]
socket_path = "/tmp/test.sock"
data_dir = "${TMP}/data"

[claude]
allowed_versions = ["2.1.109"]

[concurrency]
max_concurrent_turns = 3
max_total_sessions = 10

[recovery]
grace_window_ms = 600000

[publisher]
retry_window_ms = 600000
backoff_ms = [1000, 2000, 4000]

[limit]
warning_regex = "quota"

[observability]
ram_warn_pct = 75
ram_refuse_pct = 90
stats_interval_ms = 30000

[auth]
mode = "none"

[signing]
mode = "none"
`);
  const config = loadConfig(join(TMP, "config.toml"));
  expect(config.daemon.socket_path).toBe("/tmp/test.sock");
  expect(config.concurrency.max_concurrent_turns).toBe(3);
  expect(config.claude.allowed_versions).toEqual(["2.1.109"]);
});

test("rejects invalid config", () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, "config.toml"), `[daemon]\nsocket_path = 123`);
  expect(() => loadConfig(join(TMP, "config.toml"))).toThrow();
});
