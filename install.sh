#!/usr/bin/env bash
# para-raid installer — run from inside a cloned repo:
#   git clone https://github.com/psianion/para-raid && cd para-raid && ./install.sh
# Installs dependencies, then hands off to `para-raid setup`, which checks
# prerequisites and writes the config + bearer token + signing secret, installs
# the systemd unit, and runs doctor. Safe to re-run; setup never overwrites an
# existing config.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v bun >/dev/null 2>&1 || { printf '\033[31merror:\033[0m bun not found — install it first: https://bun.sh\n' >&2; exit 1; }

printf '\033[1m==>\033[0m installing dependencies\n'
( cd "$REPO_DIR" && bun install )
( cd "$REPO_DIR" && bun link >/dev/null 2>&1 || true )

printf '\033[1m==>\033[0m running setup\n'
exec bun run "$REPO_DIR/src/bin/para-raid.ts" setup
