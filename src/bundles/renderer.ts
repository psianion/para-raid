import { writeFileSync } from "fs";
import { join } from "path";
import type { Bundle } from "./loader";
export { loadBundles } from "./loader";

export function renderMcpJson(bundles: Bundle[], bundleName: string, cwd: string): void {
  const bundle = bundles.find(b => b.name === bundleName);
  if (!bundle) throw new Error(`Unknown MCP bundle: "${bundleName}"`);

  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of bundle.servers) {
    if (server.type === "stdio") {
      mcpServers[server.name] = { command: server.command, args: server.args ?? [] };
    } else {
      mcpServers[server.name] = { url: server.url };
    }
  }

  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers }, null, 2));
}
