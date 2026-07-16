# para-raid — VPS runbook

para-raid stays a **native** systemd `--user` service, never dockerized —
it needs tmux, a subscription-authenticated `claude` CLI, and a unix socket
its own SECURITY.md forbids exposing over TCP.

For the whole-stack picture (scrypt + uxie + para-raid topology, secrets
layout, disaster recovery order), see `scrypt/scripts/vps/STACK.md`.

## Deploy model

`install.sh` → `para-raid setup` (writes config + token + signing secret,
installs the systemd `--user` unit, runs doctor) → `para-raid up`. This
directory only adds the updater on top of that existing pattern — nothing
here replaces `install.sh` or `setup`.

## Bootstrap (one-time, on the VPS)

```bash
sudo install -m 0755 -o ubuntu -g ubuntu \
  scripts/vps/update-para-raid.sh /home/ubuntu/bin/update-para-raid

# REQUIRED — without linger, the --user unit dies the moment the ubuntu
# session logs out and won't start again on boot.
sudo loginctl enable-linger ubuntu
```

Journald disk usage cap: edit `/etc/systemd/journald.conf` and set
`SystemMaxUse=500M`, then `sudo systemctl restart systemd-journald`. This is
a global cap, not a per-unit one — `~/.config/systemd/user/para-raid.service.d/override.conf`
is the right place for a `[Service]` override (e.g. `LogRateLimitIntervalSec=`/
`LogRateLimitBurst=` if para-raid ever logs excessively) but it cannot set
`SystemMaxUse=`, which only `journald.conf` understands.

## Update flow

```bash
ssh para-raid '~/bin/update-para-raid'
```

Or nightly via cron: `45 2 * * * /home/ubuntu/bin/update-para-raid` (staggered
after scrypt/uxie/vault-backup — see scrypt's `scripts/vps/STACK.md` cron table).

`update-para-raid` is idempotent (no-ops when already on `origin/main`) and
single-instance (flock). On update it stops the service, snapshots the
SQLite DB (`para-raid.db` + `-wal`/`-shm`) out of `data_dir`
(`~/.local/state/para-raid` by default), pulls, reinstalls deps, typechecks,
and restarts — gated on `para-raid status` succeeding within 30s. Any
failure after the stop restores the snapshotted DB files and `git reset --hard`s
back to the previous commit, so code and schema never drift apart: migrations are
forward-only with no down path, so rolling back code without the matching DB
would corrupt it once a migration beyond 001 exists.

## Health

- `para-raid status` — liveness (mode, session counts). This is what the
  updater gates on.
- `para-raid doctor` — deeper check, including whether the `claude` CLI's
  subscription login is still valid. A lapsed subscription session is the
  most likely *silent* failure mode (the daemon keeps running, sessions just
  stop working), so it's not part of the update gate — run it separately:

  ```bash
  # crontab -e
  0 9 * * * para-raid doctor >/dev/null 2>&1 || "$HOME/bin/sup-notify" "para-raid doctor failing — check claude auth"
  ```

## Librarian (nightly vault maintenance)

`librarian.timer` → `librarian.service` → `librarian-run.sh`: closes last
night's session, then opens a fresh one (`--adapter-id uxie`, ref
`librarian:<utc-date>`, bundle `scrypt`, prompt from `librarian-prompt.txt`).
The digest reply reaches Discord through uxie's normal `turn_replied` webhook.

Setup:

```bash
install -m 0755 scripts/vps/librarian-run.sh ~/para-raid/scripts/vps/  # repo path is fine too
cp scripts/vps/librarian.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now librarian.timer
```

Raise `[concurrency].turn_timeout_ms` in `config.toml` (e.g. `1800000` = 30
min): the librarian's first turn does real work, and a timed-out first turn
kills the session and drops the reply. Failures (daemon down, quota-paused,
pool full) post to Discord via `~/bin/sup-notify` when present.
