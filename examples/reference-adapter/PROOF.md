# Proof: validated against a real `claude` session

This adapter was driven end-to-end against a **live daemon running a real
logged-in `claude` (Max) worker in tmux** — not the hermetic test harness. A
real model turn comes back as a signed `turn_replied` the receiver verifies.

## Reproduce (the real proof — run it yourself)

With a daemon running (bearer auth + `signing.mode = "hmac"`, an adapter whose
`webhook_url` points at the receiver, and a logged-in `claude`):

```sh
PARARAID_SOCKET=/path/to/api.sock \
PARARAID_ADAPTER_TOKEN=<adapter token> \
PARARAID_SIGNING_SECRET=<hmac secret> \
bun run examples/reference-adapter/main.ts
# exits 0 on turn_replied
```

## Captured run (2026-06-25, PII redacted)

Daemon boot — a real account, on the **Max** subscription:

```
{"event":"daemon.boot.claude_ok","detail":"<account-redacted> (max)"}
```

Reference-adapter output — the full signed webhook sequence, received and
HMAC-verified (the receiver returns 401 and records nothing on a bad signature,
so a recorded event is a verified event):

```
[receiver] listening at http://127.0.0.1:18900/hook (verifying HMAC)
[client] open_session -> 202 {"session_id":"d86ebf78-…","turn_id":"cd03cced-…","status":"launching"}
[webhook] session_open_acknowledged session=d86ebf78-…
[webhook] session_live              session=d86ebf78-…
[webhook] turn_replied              session=d86ebf78-… {"…,"reply":"READY"}
[result]  reply="READY"
[client]  close_session -> 200
[outcome] turn_replied
```

`hook-events.jsonl` — the `SessionStart` line **written by the real `claude`
worker** (note `model` and the real `transcript_path`; FakeTmux in the
integration tests cannot produce these):

```json
{"session_id":"d86ebf78-…","transcript_path":"~/.claude/projects/…/d86ebf78-….jsonl","hook_event_name":"SessionStart","source":"startup","model":"claude-opus-4-8[1m]","ts":1782399418131}
```

## Why this is conclusive

The hermetic e2e (`tests/integration/reference-adapter.test.ts`) uses a fake
tmux and a stubbed reply, so it can never yield a `(max)` login, a real
`claude-opus-4-8[1m]` `SessionStart`, or a real `transcript_path`. This run did
— through the actual daemon, tailer, publisher, HMAC signing, and a real model
turn. It is also what surfaced the tailer launch-deadlock fixed in this PR.
