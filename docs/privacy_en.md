# Data and privacy

[简体中文](./privacy.md) | English

**In one sentence:** conversations, memory, files and keys are stored on your device; whatever you send to a model goes through this site's relay service to the model provider you chose. We do not claim your data is beyond all risk — anything sent to a model leaves your device.

This document explains what zdzui Assistant stores where, what leaves your device, and how to delete it. Questions: contact us through the channel you got this software from.

## Data directory

| How you run it | Data directory |
| :--- | :--- |
| Desktop · Windows | `%APPDATA%\zdzui-assistant\data` |
| Desktop · macOS | `~/Library/Application Support/zdzui-assistant/data` |
| Desktop · Linux | `~/.config/zdzui-assistant/data` |
| Command line `npm start` | `./data` (fixed; no environment variable) |
| Docker | `/data` in the container (mounted as the `amb-data` volume in the README example) |

## Data inventory

| Data | Where it lives (inside the data directory) | Does it leave the device? | Where it goes |
| :--- | :--- | :--- | :--- |
| Conversations and sessions | `anymodel.db` (SQLite) | The part a reply needs | Sent as model context through this site's relay service to the provider you chose |
| Memory | `memory/` (Markdown: `bots/`, `groups/`, `team/`) | When it is used | Included as context in model requests; anything that looks like a secret is filtered before it is written |
| Bot workspace files | `workspaces/<bot>/` (including received files in `inbox/` and generated images and video in `media/`) | When a bot reads them and sends them to a model | Same as above |
| API key | The gateway's isolated config in `magpie/config/` | As authentication on every model request to this site's relay service | This site's relay service |
| WeChat sign-in state and sync cursor | Inside the data directory (`weixin/` and others) | When talking to the WeChat iLink API | Tencent WeChat |
| App ID / Secret of Feishu chat accounts | `anymodel.db` | When opening the long connection to the Feishu Open Platform | Feishu |
| Telegram, Slack and Discord tokens | `anymodel.db` | When talking to that platform | The platform you connected |
| Allowlist and access requests | `anymodel.db`: who may use which channel account, and the first message a stranger sent (truncated, so you can tell who it is) | No | — |
| Replies waiting to be sent | `anymodel.db` outbox: unsent message content and the reason, including WeChat messages held until the person writes again (kept up to 7 days; sent ones are deleted after 7 days, undeliverable ones after 30) | When they are sent | WeChat / Feishu |
| Background tasks and rules | `anymodel.db` (tasks, rules and run logs, kept 30 days); task folders in `workspaces/<bot>/tasks/`, deleted after 30 days unused (you are told first in Needs you); their session files in `dsh/<bot>/sessions/`, deleted with the task | While they run | As for chats: context in model requests, sent through this site's relay service to the provider you chose |
| Settings | `config.json` | No | — |
| Logs | `logs/app.log` (rotated by size) | No; "Copy diagnostics" is something you copy by hand, with keys replaced by `***` | — |
| Tokens for connected accounts (Notion, Feishu, only if you add them) | `anymodel.db`; shared by all bots | Sent to that service as authentication each time a bot reads or writes | Notion, Feishu |
| Notion content and Feishu messages a bot reads | Not stored separately; once in a chat they're stored with that chat | Yes | Sent as context in model requests, through this site's relay service to the provider you chose |
| Screenshots (computer use) | Not kept long-term | Yes | Sent as part of the model request through this site's relay service to a vision-capable model; never forwarded to WeChat or Feishu chats unless you ask for them as files |

## Accounts and sign-in

- This distribution **does not offer account sign-in**: there is nothing to register, the app never asks for a site password, and no sign-in credential is written into the data directory.
- The API key lives only on this device (the gateway's isolated config in `magpie/config/`) and is sent as authentication on every model request; it is never written to logs, and the UI only shows its last characters.
- If you suspect the key leaked: delete that key in the site's console, issue a new one, and paste the new one into the app.

## Local console access control

- The admin UI listens on `127.0.0.1:3600` by default; nothing on your LAN or the internet can reach it.
- The desktop app generates a random access token on every launch, so other local programs cannot call the admin API directly.
- When it listens on a non-loopback address (for example `0.0.0.0` in Docker), token access is enforced; the token is in the data directory as `ui-token` (Docker: `docker exec amb cat /data/ui-token`).
- Do not expose port 3600 to the internet; for remote access put it behind a VPN or an authenticating reverse proxy that you control.

## Model requests

- Model requests go from the bundled magpie gateway to this site's relay service (the address is compiled into the client and cannot be changed), which forwards them to the provider you chose.
- A request contains what the model needs to answer: the prompt, conversation context, memory in use, file contents, tool results and, with computer use, screenshots.
- Requests carry an `X-Modelflare-Skill: zdzui-assistant/<version>` header so the service can identify the source (the header name is a protocol identifier and cannot change; the value is this product); site links opened from the app carry `utm_source=zdzui`.
- The relay service keeps request logs; what is kept and for how long is decided by whoever operates the site — please ask them. How each model provider handles data is governed by its own terms.

## Telemetry

- Telemetry in the bundled computer-use driver (Cua Driver) is switched off with `CUA_TELEMETRY_ENABLED=0` and `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`.
- The bundled magpie gateway runs with auto-update and account discovery off, and does not read credentials of other AI tools on your computer.
- This product's own code (`src`, `electron`, `ui`, `scripts`, `dsh-runtime/plugins`) contains no analytics or telemetry reporting: a search for telemetry, analytics, sentry, posthog and mixpanel only matches the two Cua environment variables above.
- Bundled third-party components behave as their own documentation describes; we make no guarantees for them here.

## Other network requests the app makes

Besides model requests, the app goes online to:

- Read this site's relay service for the model catalog, your balance, usage and notifications (your account data).
- Read a model's request format from the site's model documentation endpoint when generating images or video.
- WeChat channel: talk to `ilinkai.weixin.qq.com` and download images and files you send from the WeChat CDN.
- Feishu channel: keep a long connection to the Feishu Open Platform.
- Telegram, Slack and Discord channels: once connected, talk to `api.telegram.org`, `slack.com`, `discord.com` and their file endpoints to exchange messages and the files you send.
- On Windows, with agent mode on and no working PowerShell 7 on the system, download PowerShell 7 from Microsoft's official release location (turn this off with `agent.pwshAutoInstall: false` in `config.json`; see the [development guide](./development_en.md)).

## Computer use and screenshots

- Reading the screen takes screenshots, which are sent as part of the model request to a vision-capable model.
- **Computer use is off by default**; you turn it on yourself in Bot settings → Computer use, and the first time you do it explains what data is involved.
- Once on, the default is "ask me before actions that change the screen"; reading the screen stays automatic. You can switch to "run every action automatically", but then both reading the screen and acting happen directly.
- Bots with the read-only preset only get read tools.

## Channels

- Messages you exchange with a bot on WeChat, Feishu, Telegram, Slack or Discord pass through those platforms' servers and are subject to their privacy policies.
- By default only the owner and people you allow can talk to a bot; messages from anyone else are not given to a model, only recorded as access requests (see the [developer guide](./development_en.md#who-can-use-a-bot)).

## Deleting your data

1. Quit zdzui Assistant (tray menu → Quit).
2. Delete the data directory from the table above. Docker: `docker rm -f amb && docker volume rm amb-data`.
3. If you issued an API key on the site, delete it in the site's console (it lives only on your device, so deleting the data directory removes it too).
4. If needed, disable the apps you created on the Feishu Open Platform (including any created by scanning), unbind the bot in WeChat, delete the bots you created on Telegram (@BotFather), Slack and Discord, and in Notion disconnect this app and delete any tokens you created.

This software is a derivative work of AnyModelBot (MIT). Copyright and licence notices for third-party components are in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
