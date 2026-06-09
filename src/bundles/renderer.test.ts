import { test, expect } from "bun:test";
import { loadBundles, renderMcpJson } from "./renderer";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const TMP = "/tmp/pararaid-bundles-test";

test("renders .mcp.json from bundle config", () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  const bundleToml = `
[[bundles]]
name = "scrypt-rw"

[[bundles.servers]]
type = "http"
name = "scrypt"
url = "http://localhost:8080/mcp"
`;
  writeFileSync(join(TMP, "mcp-bundles.toml"), bundleToml);

  const bundles = loadBundles(join(TMP, "mcp-bundles.toml"));
  const cwd = join(TMP, "workdir");
  mkdirSync(cwd, { recursive: true });

  renderMcpJson(bundles, "scrypt-rw", cwd);

  const mcpJson = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf-8"));
  expect(mcpJson.mcpServers.scrypt.url).toBe("http://localhost:8080/mcp");
});

test("throws on unknown bundle name", () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, "mcp-bundles.toml"), '[[bundles]]\nname = "a"');
  const bundles = loadBundles(join(TMP, "mcp-bundles.toml"));
  expect(() => renderMcpJson(bundles, "nonexistent", TMP)).toThrow();
});
