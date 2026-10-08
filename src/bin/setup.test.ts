import { test, expect } from "bun:test";
import { renderConfig, renderSystemdUnit } from "./setup";

const EXAMPLE = `[claude]
min_version = "2.1.259"

[auth]
mode = "none"   # "none" | "bearer" | "mtls". setup flips this to "bearer".
token = ""      # bearer secret; setup generates one.

[signing]
mode = "none"   # "none" | "hmac". setup flips this to "hmac".
secret = ""     # hmac secret; setup generates one.

[adapters.uxie]
webhook_url = "http://localhost/api/webhooks/para-raid"
`;

test("renderConfig pins min_version to the installed claude and enables bearer + hmac with the given secrets", () => {
  const out = renderConfig(EXAMPLE, { version: "2.1.294", token: "TKN", secret: "SEC" });
  expect(out).toContain(`min_version = "2.1.294"`);
  expect(out).toMatch(/\[auth\][\s\S]*mode = "bearer"/);
  expect(out).toContain(`token = "TKN"`);
  expect(out).toMatch(/\[signing\][\s\S]*mode = "hmac"/);
  expect(out).toContain(`secret = "SEC"`);
});

test("renderConfig leaves min_version alone when the installed version is unknown", () => {
  const out = renderConfig(EXAMPLE, { version: "", token: "T", secret: "S" });
  expect(out).toContain(`min_version = "2.1.259"`);
});

test("renderConfig preserves comments and leaves [adapters] untouched", () => {
  const out = renderConfig(EXAMPLE, { version: "9.0.0", token: "T", secret: "S" });
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
  // Workers are daemon children: the default control-group kill is what we
  // want (conversations come back via --resume), with room to close cleanly.
  expect(u).not.toContain("KillMode=process");
  expect(u).toContain("TimeoutStopSec=20");
  // claude's native installer target must be on the unit's PATH.
  expect(u).toContain("/home/me/.local/bin");
});
