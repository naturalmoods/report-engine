#!/usr/bin/env bash
# One-off CLI command with the same image, mounts, env file and secrets as the Quadlet unit.
# It reads the settings from the installed unit (Image, Volume, Secret, EnvironmentFile, UserNS, User), so there are not two lists.
# Usage: deploy/run.sh status | approve <id> [YYYY-MM] | send <id> [YYYY-MM] | log <id> "text"
set -euo pipefail

unit="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd/report-engine.container"
[ -f "$unit" ] || { echo "Nincs telepítve: $unit" >&2; exit 1; }

# Values of the given key from the [Container] section; %h is the systemd home specifier.
vals() { sed -n "s/^$1=//p" "$unit" | sed "s|%h|$HOME|g"; }

image="$(vals Image)"
args=(--rm --no-healthcheck)
[ -t 0 ] && [ -t 1 ] && args+=(-it)
for pair in Volume:volume Secret:secret EnvironmentFile:env-file UserNS:userns User:user; do
  while IFS= read -r v; do args+=("--${pair#*:}=$v"); done < <(vals "${pair%%:*}")
done

exec podman run "${args[@]}" "$image" node src/cli/index.ts "$@"
