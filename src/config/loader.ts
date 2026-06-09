import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parse } from "smol-toml";
import { ConfigSchema } from "./schema";
import type { ParaRaidConfig } from "../types";

// Expand $VAR / ${VAR} from the environment and a leading ~ to the home dir,
// so config paths like "$XDG_RUNTIME_DIR/para-raid.sock" or "~/.local/state"
// resolve instead of being created literally.
function expandPath(value: string): string {
  const expanded = value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, braced, bare) => {
      const name = braced ?? bare;
      const v = process.env[name];
      if (v === undefined) {
        throw new Error(`config: environment variable $${name} is not set`);
      }
      return v;
    }
  );
  if (expanded === "~") return homedir();
  if (expanded.startsWith("~/")) return join(homedir(), expanded.slice(2));
  return expanded;
}

export function loadConfig(path: string): ParaRaidConfig {
  const raw = readFileSync(path, "utf-8");
  const parsed = parse(raw);
  const config = ConfigSchema.parse(parsed) as ParaRaidConfig;
  config.daemon.socket_path = expandPath(config.daemon.socket_path);
  config.daemon.data_dir = expandPath(config.daemon.data_dir);
  return config;
}
