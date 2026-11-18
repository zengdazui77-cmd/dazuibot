# 大嘴助手团队版首期试点部署

这份步骤适合第一次部署团队服务的情况。首期只部署团队登录、邀请、共享聊天、用量统计和 Git 项目协作；成员继续使用现有 Windows 桌面 App。云端代码执行器先关闭，Owner 批准的代码任务会停在等待执行器状态，不会在团队 API 主机上运行代码。

## 需要准备的东西

先准备四项，不要把密码、API Key 或私钥发到聊天里：

1. 一台能安装 Docker Engine 的 Linux 云主机。建议至少 2 个 vCPU、4 GB 内存、40 GB 磁盘；数据库备份另存到主机以外的位置。
2. 一个团队域名，例如 `team.example.com`，将它的 A 记录指向云主机公网 IPv4。团队域名必须与 HTTPS 地址完全一致。
3. 一个支持 TLS 的 SMTP 发送账号，用于邮箱验证码和邀请邮件。可以使用 `smtps://`，或使用 `smtp://...?requireTLS=true`；发件地址必须是该邮件服务允许的地址。
4. 模型中转站的 HTTPS OpenAI 兼容地址。团队管理员在 App 中保存模型名称和 Key，服务端加密保存 Key；成员登录时不需要输入这把 Key。

云主机登录凭据放在云厂商控制台或运维密码管理器中；SMTP 凭据放在服务器 `.env` 文件或部署平台 Secret 中；不要提交 `.env` 到 Git，也不要把它复制到客户端。

## 如果还没有云主机

不用购买 Windows 服务器，也不用一开始配置 Kubernetes。团队成员可能在中国大陆和海外两边使用、地区暂不确定时，首期建议选择香港地域作为折中，创建 Ubuntu 24.04 LTS Linux 云主机；试点建议 2 核 CPU、4 GB 内存、至少 40 GB 磁盘和公网 IPv4。香港主机免去大陆地域服务器的 ICP 备案流程，但不代表免除其他适用的法律或平台要求；它也不能保证两地网络延迟，邀请成员前应分别从大陆和海外实测登录、SSE 聊天和邮件验证码。创建时把 SSH 登录限制为自己的固定 IP，只向公网开放 HTTP 80 和 HTTPS 443；不要开放数据库 5432 或团队 API 8787。先用单台主机和 Docker Compose，不买 Kubernetes 或独立数据库服务。

只读检查显示，`zdzui.xyz` 当前由 DNSPod 托管，根域邮件 MX 指向阿里云企业邮箱；可以考虑把 `team.zdzui.xyz` 作为团队地址，并在 DNSPod 添加指向新云主机 IPv4 的 A 记录。`team.zdzui.xyz` 目前没有查到 A 记录。现有 `api.zdzui.xyz` 虽然指向一台公网主机，但这不表示该主机有空余资源或适合与团队数据库共用；默认建议新建独立小主机。阿里云 MX 记录也不代表 SMTP 发信账号已开通，仍需在邮箱管理后台确认可用 SMTP 登录、发件邮箱和 465/587 TLS 设置。此次只读检查没有更改 DNS、邮箱、服务器或生产数据。

香港节点正式邀请成员前，用一名大陆成员和一名海外成员各做一次完整试用：申请邮箱验证码、登录、打开共享聊天、发送一条消息并保持 SSE 连接数分钟；另外确认两边都能访问模型中转站 HTTPS 地址。若一边明显超时，再根据实测调整线路或部署边缘接入，不要一开始就加 CDN/双机房，以免增加 SSE、DNS 和凭据排障复杂度。

## 首次部署

在云主机控制台创建 Ubuntu 24.04 后，用 SSH 登录。主机防火墙只开放 SSH（来源限制为自己的 IP）、HTTP 80 和 HTTPS 443；不要开放 PostgreSQL 的 5432 或团队 API 的 8787。安装 Docker 官方仓库提供的 Docker Engine、Compose 插件、Nginx 和 Certbot：

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc" | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin nginx certbot
sudo systemctl enable --now docker nginx
```

公开 GitHub 分支尚不包含这份未提交原型，因此不能直接从 GitHub 克隆后假定里面有团队服务。本次工作区生成的 `dazuibot-team-service-pilot-ready-r4.zip` 包含服务源码和部署文件，不含 `.env` 密钥、依赖目录和构建产物；对应 SHA-256 在同目录的 `.sha256` 文件中。把这个压缩包上传到云主机后运行：

```sh
sudo apt-get install -y unzip
unzip dazuibot-team-service-pilot-ready-r4.zip -d "$HOME"
cd "$HOME/team-service"
```

然后在 Linux 云主机上运行配置向导：

```sh
chmod +x ./scripts/setup-pilot-env.sh
./scripts/setup-pilot-env.sh
```

向导会询问团队域名、SMTP 邮箱服务信息和模型中转站 HTTPS 地址；输入 SMTP 密码时不会显示。它会自动生成数据库密码和 Secret，把 `.env` 限制为仅当前账户可读写，并默认关闭云端代码执行器。这个步骤只在服务器本地创建配置，不会启动容器、连接云服务或修改桌面 App。`.env` 含有邮件密码，不能提交到 Git 或发给团队成员。

向导运行前先确认域名 A 记录已指向云主机、SMTP 账号已经获准发信，并准备好模型中转站的 HTTPS 地址。遇到不认识的字段时不要猜；先向云主机或邮件服务提供商确认。之后检查配置并启动服务：

```sh
sudo docker compose config --quiet
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs --tail=100 team-api
```

API 只绑定主机的 `127.0.0.1:8787`，公网请求应由 Nginx 终止 TLS 并转发到该端口。先安装临时 HTTP 配置，以 Webroot 方式申请 TLS 证书（替换团队域名和负责证书通知的邮箱）：

```sh
sudo mkdir -p /var/www/certbot/.well-known/acme-challenge
sudo install -D -m 644 ./deploy/nginx-team-bootstrap.conf /etc/nginx/sites-available/team-bootstrap
sudo sed -i 's/team\.example\.com/team.zdzui.xyz/g' /etc/nginx/sites-available/team-bootstrap
sudo ln -s /etc/nginx/sites-available/team-bootstrap /etc/nginx/sites-enabled/team-bootstrap
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/certbot -d team.zdzui.xyz --email 你的邮箱 --agree-tos --non-interactive
```

以上命令先按建议的 `team.zdzui.xyz` 举例；若选择其他域名，请在所有命令中替换成自己的真实域名。替换建议值前，确认该域名的 A 记录已指向这台云主机。

证书申请成功后，安装正式 HTTPS 配置并启用自动续期检查：

```sh
sudo install -D -m 644 ./deploy/nginx-team.conf /etc/nginx/sites-available/team
sudo sed -i 's/team\.example\.com/team.zdzui.xyz/g' /etc/nginx/sites-available/team
sudo install -D -m 644 ./deploy/team-proxy-headers.conf /etc/nginx/snippets/team-proxy-headers.conf
sudo ln -s /etc/nginx/sites-available/team /etc/nginx/sites-enabled/team
sudo unlink /etc/nginx/sites-enabled/team-bootstrap
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
sudo bash ./scripts/check-nginx-config.sh
```

从服务器或另一台机器检查：

```sh
curl -fsS https://team.example.com/healthz
curl -fsS https://team.example.com/readyz
```

两个接口都正常后，在包含团队功能的桌面 App 版本中进入“团队账号登录”，填入 `https://team.example.com`。Owner 首次用邮箱验证码登录并创建团队，再从团队页面发邀请。成员安装同一个桌面 App 版本，使用自己的邮箱验证码登录，打开邀请链接或粘贴邀请码即可加入。当前本地原型尚未作为正式团队版公开发布，因此需先完成签名安装包和干净系统安装验证，再邀请正式成员。

这份源码包对应 Windows 团队版安装包尚未正式发布，且当前生成的安装包未签名；此处的客户端登录步骤必须等包含团队功能、完成签名和干净 Windows 安装测试的桌面版发布后才可执行。

## 试点前检查

- `TEAM_ALLOW_DEV_CODES` 必须为 `false`，生产环境不能让 API 返回登录验证码。
- `TEAM_SESSION_SECRET`、`TEAM_CREDENTIAL_SECRET` 和数据库密码不能相同；每次轮换前先保存数据库备份和凭据密钥。
- 浏览器或客户端只能使用 HTTPS 团队地址；邀请链接包含一次性令牌，不要把完整链接写入公开日志。
- Owner 在 App 中配置模型 Key 后，成员只能看到模型名称和掩码尾部；成员电脑和桌面 App 不应出现原始 Key。
- 首期不要填写 `TEAM_CODE_EXECUTOR_URL`。需要云端代码执行时，先完成 `executor/README.md` 中的 Linux 镜像、Kubernetes、NetworkPolicy 和内部 API 安全通信验证。

## 备份和停止

定期把数据库 dump 和校验文件复制到云主机以外的受限存储：

```sh
sudo sh ./scripts/backup.sh ./backups
```

恢复演练使用新数据库名，不覆盖线上库：

```sh
sudo sh ./scripts/restore-to-new-db.sh --confirm ./backups/dazuibot-team-<时间戳>.dump team_restore_<日期>
```

恢复成功后，先验证团队登录、邀请和历史消息，再决定是否切换 `DATABASE_URL`。恢复模型 Key 密文时必须取得匹配的 `TEAM_CREDENTIAL_SECRET`；数据库备份与加密密钥分开存放并限制访问。

这份步骤没有完成实际云主机、DNS、SMTP、Docker 或 Nginx 部署；它是首期上线时的操作顺序和检查表。当前仓库的本地测试不能替代公网 TLS、邮件投递、真实数据库恢复和多成员试点验证。
