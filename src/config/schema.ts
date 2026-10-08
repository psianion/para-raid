import { z } from "zod";

export const ConfigSchema = z.object({
  daemon: z.object({
    socket_path: z.string(),
    data_dir: z.string(),
  }),
  claude: z.object({
    // Workers drive `claude -p --input-format stream-json`; 2.1.259 added
    // `--permission-prompts`, which marks the headless surface this build targets.
    min_version: z.string().regex(/^\d+\.\d+\.\d+$/).default("2.1.259"),
    allowed_versions: z.array(z.string()).optional(),
    env_setup: z.string().default(""),
    model: z.string().default(""),
    extra_args: z.array(z.string()).default([]),
  }).default({}),
  concurrency: z.object({
    max_concurrent_turns: z.number().int().min(1).max(20),
    max_total_sessions: z.number().int().min(1).max(200),
    turn_timeout_ms: z.number().int().min(1000).default(300000),
  }),
  recovery: z.object({
    grace_window_ms: z.number().int().min(60000),
  }),
  publisher: z.object({
    retry_window_ms: z.number().int().min(10000),
    backoff_ms: z.array(z.number().int().min(100)),
  }),
  limit: z.object({
    warning_regex: z.string(),
    // claude reports its own quota state on every turn (`rate_limit_event`);
    // a non-allowed status pauses the daemon just like a matched warning.
    pause_on_rate_limit: z.boolean().default(true),
  }),
  observability: z.object({
    ram_warn_pct: z.number().min(0).max(100),
    ram_refuse_pct: z.number().min(0).max(100),
    stats_interval_ms: z.number().int().min(1000),
  }).refine((o) => o.ram_warn_pct < o.ram_refuse_pct, {
    message: "ram_warn_pct must be < ram_refuse_pct (the RAM valve needs a hysteresis band)",
  }),
  auth: z.object({
    mode: z.enum(["none", "bearer", "mtls"]),
    token: z.string().default(""),
  }),
  signing: z.object({
    mode: z.enum(["none", "hmac"]),
    secret: z.string().default(""),
  }),
  adapters: z.record(z.string(), z.object({ webhook_url: z.string().url(), token: z.string().min(1) })).optional().default({}),
});
