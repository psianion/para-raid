# Limitations

Para-RAID is single-user infrastructure for reaching your **own** Claude sessions from chat. It is honest about what it is — read this before relying on it.

## Scope

- **No chat front-end ships here.** This repo is the orchestrator daemon only. A messaging adapter (e.g. a Discord bot) talks to it over the unix socket; you supply or write that adapter.
- **scrypt (and any MCP backend) runs separately.** The `scrypt` bundle in `mcp-bundles.toml` only works if a scrypt MCP server is already running and reachable at the configured URL. Para-RAID just writes the `.mcp.json`.
- **Single user, one Claude seat.** Multi-tenant / sharing one subscription across people is an explicit non-goal — don't.

## Security model — single trusted operator

- **Bearer auth is enforced.** With `auth.mode = "bearer"`, every control request must carry `Authorization: Bearer <token>`, constant-time compared against `auth.token`. `install.sh` turns this on and generates a token; the bundled CLI sends it automatically. The daemon **refuses to boot** on an insecure auth config — `bearer` with a missing/short token, or the unimplemented `mtls` mode.
- **`auth.mode = "none"` is allowed only on the owner-only unix socket.** The socket is `chmod 0600` on boot, so only your user can reach it. Still keep the box behind Tailscale (or equivalent) and don't front it with a public reverse proxy.
- **HMAC webhook signing.** With `signing.mode = "hmac"` the daemon sends `X-Para-Raid-Timestamp` and `X-Para-Raid-Signature: sha256=<hmac>`, where the HMAC-SHA256 (keyed on `signing.secret`) covers `timestamp.body` — so a receiver can both authenticate and reject stale replays outside a skew window. `install.sh` enables it and generates the secret; the daemon refuses to boot on `hmac` without a real secret. Adapters that don't verify simply ignore the headers. The webhook queue may still retry an event, so verify idempotently.
- **Webhook SSRF guard.** Outbound `webhook_url`s must be `http(s)` and may not target cloud-metadata / link-local ranges (`169.254.0.0/16`, `fe80::/10`). Loopback and private addresses stay allowed because the adapter is meant to run on the same box. A hostname that *resolves* into those ranges (DNS rebinding) is not caught — only register webhook URLs you trust.
- **Workers run with `--dangerously-skip-permissions`** so a turn doesn't block waiting on you mid-task. That means a session has your shell and your `~/.claude` credential. Run it only on a box you control, with your own account.

## Operational

- **Doctor first.** `para-raid doctor` checks prerequisites, that `claude` is logged in, that `ANTHROPIC_API_KEY` is unset (so you bill your subscription, not the API), that the auth and signing configs are secure, and that `data_dir` is durable + writable. The daemon refuses to boot if `claude` is not logged in or the auth/signing config is insecure.
- **Cost & memory safety.** Quota self-pause is wired: the daemon scans each completed turn's reply for claude's usage-limit warnings (`limit.warning_regex`) and pauses — new turns get `503` — until you `resume`. A RAM valve pauses new work when the daemon's RSS exceeds `observability.ram_refuse_pct` of its memory cap and auto-resumes below `ram_warn_pct` (which must be `<` refuse, enforced at boot); the systemd unit's `MemoryHigh`/`MemoryMax` remain the hard cap. Caveats: the limit scan only sees the final assistant message of a normally-completed turn (not mid-turn output, a timed-out turn, or a transcript-poll fallback) and only its last ~4 KB; the RAM percentage is of the cgroup `memory.max` cap when present (else physical RAM) and counts only the daemon process, not system-wide pressure or per-session RAM.
- **Not yet validated end-to-end by a real adapter.** Unit + integration tests pass and it has run under FakeTmux and burn-in, but treat a fresh deployment as beta.
