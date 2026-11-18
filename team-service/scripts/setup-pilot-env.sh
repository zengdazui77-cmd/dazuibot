#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '配置未写入：%s\n' "$1" >&2; exit 1; }

[[ -f .env.example && -f compose.yaml && -f Dockerfile ]] || fail "请先进入 team-service 目录"
[[ ! -e .env ]] || fail ".env 已存在；为避免覆盖凭据，脚本不会改写它"
command -v openssl >/dev/null 2>&1 || fail "需要 openssl 来生成随机密码和 Secret"
command -v python3 >/dev/null 2>&1 || fail "需要 python3 来校验域名并编码 SMTP 凭据"

read -r -p '团队域名（例如 team.example.com）: ' team_host
team_host=$(python3 -c 'import sys; print(sys.stdin.read().strip().lower(),end="")' <<<"$team_host")
python3 -c 'import ipaddress,re,sys; h=sys.stdin.read().strip().lower(); labels=h.split("."); valid=(len(h)<=253 and len(labels)>=2 and all(len(x)<=63 and re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?",x) for x in labels) and not h.endswith((".localhost",".local",".example",".invalid",".test"))); 
try: ipaddress.ip_address(h); valid=False
except ValueError: pass
sys.exit(0 if valid else 1)' <<<"$team_host" || fail "请输入真实公网 DNS 域名，不要使用示例域名或 IP 地址"

read -r -p 'SMTP 服务器域名: ' smtp_host
smtp_host=$(python3 -c 'import sys; print(sys.stdin.read().strip().lower(),end="")' <<<"$smtp_host")
python3 -c 'import re,sys; h=sys.stdin.read().strip().lower(); labels=h.split("."); sys.exit(0 if len(h)<=253 and len(labels)>=2 and all(len(x)<=63 and re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?",x) for x in labels) else 1)' <<<"$smtp_host" || fail "SMTP 主机必须是有效 DNS 域名"
read -r -p 'SMTP 端口（465 或 587）: ' smtp_port
smtp_port=$(python3 -c 'import sys; print(sys.stdin.read().strip(),end="")' <<<"$smtp_port")
[[ "$smtp_port" == 465 || "$smtp_port" == 587 ]] || fail "首期只支持 TLS 465 或 STARTTLS 587 端口"
read -r -p 'SMTP 登录账号: ' smtp_user
[[ -n "$smtp_user" && "$smtp_user" != *$'\n'* ]] || fail "SMTP 登录账号不能为空"
read -r -s -p 'SMTP 密码（输入不会显示）: ' smtp_password
printf '\n'
[[ -n "$smtp_password" ]] || fail "SMTP 密码不能为空"
read -r -p '已验证可发信的发件邮箱: ' mail_from
mail_from=$(python3 -c 'import sys; print(sys.stdin.read().strip(),end="")' <<<"$mail_from")
python3 -c 'import re,sys; e=sys.stdin.read().strip(); sys.exit(0 if re.fullmatch(r"[A-Za-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+",e) and not e.lower().endswith(("@localhost","@example.com","@example.net","@example.org")) else 1)' <<<"$mail_from" || fail "请输入真实且已获 SMTP 授权的发件邮箱地址"

default_model_url='https://api.zdzui.xyz/v1'
read -r -p "模型中转站 HTTPS 地址 [$default_model_url]: " model_base_url
model_base_url=${model_base_url:-$default_model_url}
model_base_url=$(python3 -c 'import sys; print(sys.stdin.read().strip(),end="")' <<<"$model_base_url")
python3 -c 'from urllib.parse import urlsplit; import sys; u=urlsplit(sys.stdin.read().strip()); valid=(u.scheme=="https" and bool(u.hostname) and not u.username and not u.password and not u.query and not u.fragment and u.hostname.lower() not in ("localhost","127.0.0.1","::1")); sys.exit(0 if valid else 1)' <<<"$model_base_url" || fail "模型地址必须是无凭据、无查询参数的 HTTPS 地址"

smtp_user_encoded=$(printf %s "$smtp_user" | python3 -c 'import sys; from urllib.parse import quote; print(quote(sys.stdin.read(),safe=""),end="")')
smtp_password_encoded=$(printf %s "$smtp_password" | python3 -c 'import sys; from urllib.parse import quote; print(quote(sys.stdin.read(),safe=""),end="")')
mail_from_escaped=$(printf %s "$mail_from" | python3 -c 'import sys; s=sys.stdin.read(); sys.stdout.write(s.replace(chr(39),chr(92)+chr(39)))')
model_base_url_escaped=$(printf %s "$model_base_url" | python3 -c 'import sys; s=sys.stdin.read(); sys.stdout.write(s.replace(chr(39),chr(92)+chr(39)))')
unset smtp_password
if [[ "$smtp_port" == 465 ]]; then
  smtp_url="smtps://${smtp_user_encoded}:${smtp_password_encoded}@${smtp_host}:465"
else
  smtp_url="smtp://${smtp_user_encoded}:${smtp_password_encoded}@${smtp_host}:587/?requireTLS=true"
fi
unset smtp_password_encoded smtp_user_encoded

pg_password=$(openssl rand -hex 24)
session_secret=$(openssl rand -hex 32)
credential_secret=$(openssl rand -hex 32)
tmp=$(mktemp .env.tmp.XXXXXX)
trap 'rm -f "$tmp"; unset smtp_url mail_from_escaped model_base_url_escaped' EXIT
cat >"$tmp" <<EOF
NODE_ENV=production
PORT=8787
HOST=0.0.0.0
TEAM_API_CPUS=1.0
TEAM_API_MEMORY_LIMIT=1g
PG_DB=dazuibot_team
PG_USER=dazuibot
PG_PASSWORD=$pg_password
DATABASE_URL=postgres://dazuibot:$pg_password@postgres:5432/dazuibot_team
TEAM_HOST=$team_host
TEAM_PUBLIC_URL=https://$team_host
TEAM_SESSION_SECRET=$session_secret
TEAM_CREDENTIAL_SECRET=$credential_secret
TEAM_MODEL_BASE_URL='$model_base_url_escaped'
TEAM_SMTP_URL=$smtp_url
TEAM_MAIL_FROM='Dazuibot Teams <$mail_from_escaped>'
TEAM_ALLOW_DEV_CODES=false
TEAM_CODE_EXECUTOR_URL=
TEAM_CODE_EXECUTOR_BROKER_URL=
TEAM_CODE_EXECUTOR_SECRET=
TEAM_CODE_EXECUTOR_POLL_MS=1000
CORS_ORIGINS=
EOF
chmod 600 "$tmp"
if ! ln "$tmp" .env; then fail ".env 已存在或无法安全创建，原文件未覆盖"; fi
rm -f "$tmp"
trap - EXIT
unset pg_password session_secret credential_secret smtp_url mail_from_escaped model_base_url_escaped
printf '已安全创建 .env（权限 600）。云端代码执行器保持关闭。\n'
printf '下一步：先将 %s 的 DNS A 记录指向云主机，再按 deploy/first-pilot-zh.md 配置 HTTPS 代理并运行 docker compose config --quiet。\n' "$team_host"
