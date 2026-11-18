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
  # nginx -t 不只是读配置：它会真的去打开 access_log 指定的文件、真的去 bind
  # listen 的端口。所以要把它当成「这份配置在 CI 机器上能不能起来」来准备：
  #   - access_log 指到临时目录（默认是 /var/log/nginx/access.log，非 root 写不了）
  #   - listen 80/443 换成高位端口（80/443 是特权端口，CI 里非 root 绑不了）
  # 换端口不影响要验的东西：这个检查要确认的是配置语法与引用完整。
  sed \
    -e "s|/etc/nginx/snippets/team-proxy-headers.conf|$deploy_dir/team-proxy-headers.conf|g" \
    -e "s|/etc/letsencrypt/live/team.example.com|$tmp/certs|g" \
    -e "s|/var/log/nginx/team-access.log|$tmp/team-access.log|g" \
    -e "s|listen 80;|listen $port;|" \
    -e "s|listen 443 ssl http2;|listen $((port + 1)) ssl http2;|" \
    "$source" >"$rendered"
  cat >"$tmp/nginx.conf" <<EOF
pid $tmp/nginx.pid;
error_log $tmp/error.log;
events {}
http {
    access_log $tmp/access.log;
    include $rendered;
}
EOF
  nginx -t -p "$tmp/" -c "$tmp/nginx.conf"
}

# 高位端口，避免和 CI 机器上已有的服务撞上
port=${TEAM_NGINX_CHECK_PORT:-18080}

check_config "$deploy_dir/nginx-team-bootstrap.conf"
check_config "$deploy_dir/nginx-team.conf"
printf 'Nginx bootstrap and team proxy configurations are valid.\n'
