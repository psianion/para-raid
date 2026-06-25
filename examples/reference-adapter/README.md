# Reference adapter

The smallest correct para-raid adapter. Copy this directory as the starting
point for a real one (a chat bot, a web backend, …). It is the executable
definition of the wire contract — the end-to-end test in
`tests/integration/reference-adapter.test.ts` drives it against a live daemon.

An adapter has exactly two responsibilities:

## 1. Drive sessions — `client.ts`

Talk to the daemon over its unix socket. Identity is your **per-adapter bearer
token** alone (configured under `[adapters.<id>]` in the daemon's config); the
daemon ignores any `X-Adapter-Id` header. Send a fresh `Idempotency-Key` on
every mutating call so a retry is a server-side no-op.

```ts
const client = createReferenceClient({ socketPath: "/run/para-raid/api.sock", token: MY_TOKEN });
const { body } = await client.openSession({ adapter_ref: "chat-42", prompt: "hello" });
// body.session_id is launching; wait for the session_live webhook before sending turns.
await client.sendTurn({ session_id: body.session_id, prompt: "and again" });
```

Responses are async: `open_session` returns `202 {session_id, turn_id, status:"launching"}`
immediately — the real progress arrives as webhooks.

## 2. Receive webhooks — `receiver.ts`

Expose one HTTP endpoint and set its URL as your adapter's `webhook_url`. The
daemon POSTs every event to it as raw JSON `{ event_type, session_id, ...payload }`.

Two things every adapter must do:

- **Verify the signature** when the daemon runs `signing.mode = "hmac"`. Each
  delivery carries `X-Para-Raid-Timestamp` and `X-Para-Raid-Signature`
  (`sha256=<hex>` = HMAC-SHA256 over `` `${timestamp}.${rawBody}` `` with the shared
  `signing.secret`). Reject anything that doesn't verify; compare constant-time.
- **Dedupe on `X-Para-Raid-Event-Id`.** The daemon redelivers after a transient
  non-2xx, and the timestamp changes per attempt, so the event id is the only
  stable idempotency key. Return 2xx to mark delivered; anything else triggers retry.

## Event types

`session_open_acknowledged` · `session_live` · `tool_call` · `turn_replied` ·
`turn_failed` · `turn_cancelled` · `session_closed` · `session_recycled` ·
`session_recover_candidate` · `session_resumed` · `session_dead` (inspect
`payload.reason`) · `paused` / `resumed` (daemon-wide, `session_id` is null).

A normal turn looks like: `session_open_acknowledged → session_live →
tool_call* → turn_replied`.
