# Security

Para-RAID is single-user infrastructure: you run it on **your own** box, under **your own** account, to reach **your own** Claude sessions from chat. Its security model assumes exactly one trusted operator. See [LIMITATIONS.md](LIMITATIONS.md) for the honest boundaries.

## Trust model

- **Workers run claude with `--dangerously-skip-permissions`.** A session therefore has your shell and your `~/.claude` credential and can run commands on the box. Run para-raid **only** on a machine you control, with your own account — never a shared or multi-tenant host.
- **The control plane is a unix socket**, created under an owner-only (`0700`) directory and `chmod 0600` on boot. With `auth.mode = "bearer"` (the installer's default) every request must present `Authorization: Bearer <token>`, compared in constant time. The daemon **refuses to boot** on an insecure auth config (bearer without a real token, or the unimplemented `mtls`).
- **Outbound webhooks** are guarded against SSRF (no non-`http(s)`, no cloud-metadata/link-local targets) and, with `signing.mode = "hmac"` (installer default), signed with `X-Para-Raid-Signature` so your adapter can verify them.
- **Secrets at rest:** `config.toml` holds the bearer token and signing secret and is written `chmod 600`. `~/.claude` / `~/.claude.json` are live credentials. Never commit either, bake them into an image, or push them to a registry.

## Hardening checklist

- Keep the box on a private network (Tailscale or equivalent); **do not** expose the socket via a public reverse proxy or a TCP port.
- Use key-only SSH and a host firewall defaulting to tailnet-only.
- Prefer a **dedicated Claude seat** over your daily-driver account.
- Run `para-raid doctor` after install — it checks login, that `ANTHROPIC_API_KEY` is unset, and that the auth/signing configs are secure.
- Only register webhook URLs you trust (the SSRF guard does not cover DNS names that resolve into blocked ranges).

## Reporting a vulnerability

Para-RAID is invite-only and not a marketed public project. If you find a security issue, please report it **privately** — open a GitHub security advisory on the repository or contact the maintainer directly. Do **not** open a public issue for a vulnerability.
