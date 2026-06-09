import { test, expect } from "bun:test";
import { renderConfig, renderSystemdUnit } from "./setup";

const EXAMPLE = `[claude]
allowed_versions = ["1.0.0", "2.0.0"]

[auth]
mode = "none"   # "none" | "bearer" | "mtls". install.sh flips this to "bearer".
token = ""      # bearer secret; install.sh generates one.

[signing]
mode = "none"   # "none" | "hmac". install.sh flips this to "hmac".
secret = ""     # hmac secret; install.sh generates one.

[adapters.uxie]
webhook_url = "http://localhost/api/webhooks/para-raid"
`;

test("renderConfig pins the version and enables bearer + hmac with the given secrets", () => {
  const out = renderConfig(EXAMPLE, { version: "2.1.119", token: "TKN", secret: "SEC" });
  expect(out).toContain(`allowed_versions = ["2.1.119"]`);
  expect(out).toMatch(/\[auth\][\s\S]*mode = "bearer"/);
  expect(out).toContain(`token = "TKN"`);
  expect(out).toMatch(/\[signing\][\s\S]*mode = "hmac"/);
  expect(out).toContain(`secret = "SEC"`);
});

test("renderConfig preserves comments and leaves [adapters] untouched", () => {
  const out = renderConfig(EXAMPLE, { version: "9", token: "T", secret: "S" });
  expect(out).toContain(`# "none" | "bearer" | "mtls"`);            // comment kept
  expect(out).toContain(`webhook_url = "http://localhost/api/webhooks/para-raid"`);
  const adapters = out.slice(out.indexOf("[adapters.uxie]"));
  expect(adapters).not.toContain("bearer");                          // no leak past the sections
  expect(adapters).not.toContain("hmac");
});

test("renderSystemdUnit emits the key hardening lines", () => {
  const u = renderSystemdUnit({ configPath: "/c/config.toml", repoDir: "/r", bunPath: "/b/bun", home: "/home/me" });
  expect(u).toContain("Environment=PARARAID_CONFIG=/c/config.toml");
  expect(u).toContain("UnsetEnvironment=ANTHROPIC_API_KEY");
  expect(u).toContain("ExecStart=/b/bun run /r/src/daemon.ts");
  expect(u).toContain("MemoryMax=95%");
  expect(u).toContain("WantedBy=default.target");
});
