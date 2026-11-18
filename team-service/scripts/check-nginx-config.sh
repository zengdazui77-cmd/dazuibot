#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
deploy_dir=$(CDPATH= cd -- "$script_dir/../deploy" && pwd)
command -v nginx >/dev/null 2>&1 || { printf 'nginx is required for this check\n' >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { printf 'openssl is required for this check\n' >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT HUP INT TERM
mkdir -p "$tmp/certs"
mkdir -p "$tmp/logs"
openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
  -subj '/CN=team.example.com' \
  -keyout "$tmp/certs/privkey.pem" -out "$tmp/certs/fullchain.pem" >/dev/null 2>&1

check_config() {
  local source=$1
  local rendered="$tmp/$(basename "$source")"
  sed \
    -e "s|/etc/nginx/snippets/team-proxy-headers.conf|$deploy_dir/team-proxy-headers.conf|g" \
    -e "s|/etc/letsencrypt/live/team.example.com|$tmp/certs|g" \
    -e "s|/var/log/nginx/team-access.log|$tmp/team-access.log|g" \
    "$source" >"$rendered"
  cat >"$tmp/nginx.conf" <<EOF
pid $tmp/nginx.pid;
error_log $tmp/error.log;
events {}
http {
    include $rendered;
}
EOF
  nginx -t -p "$tmp/" -c "$tmp/nginx.conf"
}

check_config "$deploy_dir/nginx-team-bootstrap.conf"
check_config "$deploy_dir/nginx-team.conf"
printf 'Nginx bootstrap and team proxy configurations are valid.\n'
