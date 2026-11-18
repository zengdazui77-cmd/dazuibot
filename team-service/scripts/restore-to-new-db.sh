#!/bin/sh
set -eu

if [ "${1:-}" != "--confirm" ] || [ "$#" -ne 3 ]; then
  printf 'Usage: %s --confirm BACKUP.dump NEW_DATABASE_NAME\n' "$0" >&2
  exit 2
fi

backup=$(CDPATH= cd -- "$(dirname -- "$2")" && pwd)/$(basename -- "$2")
target=$3
case "$target" in
  ''|[!A-Za-z_]*|*[!A-Za-z0-9_]* ) printf 'Invalid PostgreSQL database name.\n' >&2; exit 2 ;;
esac
if [ "${#target}" -gt 63 ]; then printf 'Database name is too long.\n' >&2; exit 2; fi
if [ ! -s "$backup" ]; then printf 'Backup file is missing or empty: %s\n' "$backup" >&2; exit 2; fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$script_dir"
checksum="$(dirname -- "$backup")/$(basename -- "$backup").sha256"
if [ ! -f "$checksum" ]; then printf 'Backup checksum file is missing: %s\n' "$checksum" >&2; exit 2; fi
(cd -- "$(dirname -- "$backup")" && sha256sum --check -- "$(basename -- "$checksum")")

created=0
cleanup() {
  if [ "$created" -eq 1 ]; then
    docker compose exec -T postgres sh -ec 'dropdb --if-exists --username="$POSTGRES_USER" "$1"' -- "$target" || true
  fi
}
trap cleanup EXIT

docker compose exec -T postgres sh -ec 'createdb --username="$POSTGRES_USER" "$1"' -- "$target"
created=1
docker compose exec -T postgres sh -ec 'pg_restore --exit-on-error --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$1" -' -- "$target" < "$backup"
docker compose exec -T postgres sh -ec 'test "$(psql --username="$POSTGRES_USER" --dbname="$1" --tuples-only --no-align --command="SELECT count(*) FROM team_schema_migrations")" -gt 0' -- "$target"
created=0
trap - EXIT
printf 'Backup restored to new database: %s\nUpdate DATABASE_URL to this database, verify the matching TEAM_CREDENTIAL_SECRET, then restart team-api. The previous database was not modified.\n' "$target"
