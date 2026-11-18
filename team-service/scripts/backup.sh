#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$script_dir"

backup_dir=${1:-./backups}
umask 077
mkdir -p -- "$backup_dir"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
name="dazuibot-team-$timestamp.dump"
output="$backup_dir/$name"
temporary="$output.tmp"
trap 'rm -f -- "$temporary"' EXIT HUP INT TERM

docker compose exec -T postgres sh -ec 'pg_dump --format=custom --no-owner --no-acl --username="$POSTGRES_USER" "$POSTGRES_DB"' > "$temporary"
test -s "$temporary"
mv -- "$temporary" "$output"
(cd -- "$backup_dir" && sha256sum -- "$name" > "$name.sha256")
printf 'Backup created: %s\nChecksum: %s.sha256\n' "$output" "$output"
