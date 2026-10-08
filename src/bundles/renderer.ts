import { writeFileSync } from "fs";
import { join } from "path";
import type { Bundle } from "./loader";
export { loadBundles } from "./loader";

/** Writes `<cwd>/.mcp.json` for the named bundle and returns its path (the
 *  worker gets it via `--mcp-config`). Throws on an unknown bundle name. */
export function renderMcpJson(bundles: Bundle[], bundleName: string, cwd: string): string {
  const bundle = bundles.find(b => b.name === bundleName);
  if (!bundle) throw new Error(`Unknown MCP bundle: "${bundleName}"`);

  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of bundle.servers) {
    if (server.type === "stdio") {
      mcpServers[server.name] = { type: "stdio", command: server.command, args: server.args ?? [] };
    } else {
      // "type" is REQUIRED for url-based servers: without it claude parses
      // the entry as a command-less stdio server and silently drops it.
      mcpServers[server.name] = { type: "http", url: server.url };
    }
  }

  const path = join(cwd, ".mcp.json");
  writeFileSync(path, JSON.stringify({ mcpServers }, null, 2));
  return path;
}
