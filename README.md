# para-raid

Para-RAID is a single-user daemon that hosts your own long-running `claude` (Claude Code) sessions and relays messages to and from them for chat adapters (e.g. a Discord bot). You stay in the loop: an adapter forwards a message you sent, Para-RAID hands it to your session, and a webhook delivers the reply back. Sessions live inside detached tmux panes and transcripts persist to disk.

See [LIMITATIONS.md](LIMITATIONS.md) for what does and doesn't ship today, [SECURITY.md](SECURITY.md) for the trust model, and [NOTICE.md](NOTICE.md) for terms.

## Quickstart

The whole operator path is **setup → up → status**:

```bash
git clone https://github.com/psianion/para-raid && cd para-raid
claude auth login        # one-time: uses your own Claude subscription
./install.sh             # installs deps, then runs `para-raid setup` (config + token + signing secret + systemd unit + doctor)
para-raid up             # start it (systemd --user; or foreground if there's no systemd)
para-raid status         # confirm it's live
loginctl enable-linger "$USER"   # optional: keep it running after you log out
```

`para-raid setup` is idempotent and never overwrites an existing `~/.config/para-raid/config.toml`. Re-run `para-raid doctor` any time, or `para-raid help` to see all commands.

## Configure

- `~/.config/para-raid/config.toml` — copied from `config.example.toml` (written `chmod 600`). Paths support `~` and `$VAR`. `install.sh` sets `[auth] mode = "bearer"` and generates a `token` (the bundled CLI sends it automatically) and `[signing] mode = "hmac"` with a generated `secret` (webhooks carry an `X-Para-Raid-Signature` adapters can verify) — so keep this file private. nvm users: set `claude.env_setup = "source ~/.nvm/nvm.sh"` so the worker can find `claude`.
- `~/.config/para-raid/mcp-bundles.toml` — optional MCP backends (e.g. scrypt); copied from `mcp-bundles.example.toml`. A session names a bundle in `open_session`; the daemon writes a matching `.mcp.json` into the worker's workdir.

## Advanced — drive a session by hand

Normally your **adapter** opens sessions and sends turns over the socket; you rarely run these yourself. They're here for testing:

```bash
SID=$(para-raid open-session --adapter-id me --adapter-ref test-1 --prompt "say hi" --json | jq -r .session_id)
para-raid sessions show "$SID"
para-raid send-turn --id "$SID" --prompt "what is 2+2?"
para-raid close-session --id "$SID"
```

## Health

```bash
para-raid status
para-raid stats
para-raid dead-letters list
```

The daemon **auto-pauses** when claude warns it's near a usage limit or when memory runs high (`observability.*`); `para-raid status` shows `mode=paused` and `para-raid resume` clears it.

## Tests

```bash
bun test                  # unit + integration suite
bunx tsc --noEmit         # typecheck
bun run smoke:integration # FakeTmux flows
bun run smoke:e2e         # real claude, drives the systemd daemon (~3 min)
bun run smoke:burn-in     # real claude, leaves a session live for hours
```

## Notes

Product roadmap and operator notes are kept in `docs/` — **local-only** (`docs/` is gitignored, so they stay on the operator's box and aren't part of this repo).
