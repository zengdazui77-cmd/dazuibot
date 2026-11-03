<p align="center">
  <img src="docs/assets/brand/logo-eyes.webp" width="120" height="120" alt="dazuibot Eyes mark: two vertical pill-shaped eyes that glance left and right">
</p>

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/wordmark-dark.svg">
    <img src="docs/assets/brand/wordmark-light.svg" height="40" alt="dazuibot">
  </picture>
</h1>

<p align="center"><b>Your own AI bot, on your own computer. Any model, pay per use.</b></p>

<p align="center">
  <a href="https://zdzui.xyz/?utm_source=zdzui&utm_campaign=amb_readme">Site</a> |
  <a href="./README.md">简体中文</a> |
  English |
  <a href="https://zdzui.xyz/pricing?utm_source=zdzui&utm_campaign=amb_readme">Pricing</a> |
  <a href="./docs/development_en.md">Development</a>
</p>

<div align="center">

[![License][license-shield]](./LICENSE)

[![Platform][platform-shield]]
[![Pricing][pricing-shield]][pricing-link]

</div>

<p align="center">
  <img src="docs/assets/hero/hero-demo.gif" alt="dazuibot in action: paste an API key on first launch, pick a model, ask a bot to tidy a folder, and approve a file move" width="100%">
</p>

# 🤖 dazuibot

dazuibot is a local-first AI agent app for Windows, macOS and Linux. A bot is a persona with its own default model, workspace and memory. Chat with it in the app, or reach it from WeChat, Feishu, Telegram, Slack or Discord. Let it read and write files, run commands and operate your desktop, with an approval prompt whenever it steps outside its workspace.

Your conversations, memory, files and API keys live on your device. Models come from this site's relay ([zdzui.xyz](https://zdzui.xyz/?utm_source=zdzui&utm_campaign=amb_readme)): one API key, any model, priced per token. dazuibot itself has no subscription.

Like xAI's Grok Bot, OpenAI's dots and Anthropic's Claude Duet, it is an always-on personal AI agent: it works in the background and checks in when a decision is yours. The difference: dazuibot is open source (MIT), runs on your own computer or server, works with any model (GPT, Claude, Gemini, Grok and more) and is pay-per-use, with no single vendor's subscription ([full comparison](#-anymodelbot-vs-grok-bot-openai-dots-and-claude-duet)).

It is a Super Agent out of the box: background tasks, scheduled rules and Needs you need no extra setup. The design draws on DeepSeek's [super-agent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype), and the agent runs on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ([the full story, in Chinese](./docs/blog/superagent.md)).

📥 [Download](#-download) · 🌠 [Screenshots](#-screenshots) · 🌟 [Features](#-key-features) · 🆚 [Compare](#-anymodelbot-vs-grok-bot-openai-dots-and-claude-duet) · 🔐 [Privacy](#-how-it-works--privacy)

---

## This site's relay

Every model in dazuibot comes from this site's relay: <https://zdzui.xyz>. One API key opens 68 text, image and video models, including GPT, Claude, Gemini, Grok, DeepSeek, Kimi and GLM, over OpenAI, Anthropic, Gemini and other common API formats. Billing is per token and the price list is public.

**Sign up, create a key, paste it back — three steps**

1. **Sign up on the site.** Open [zdzui.xyz/sign-up](https://zdzui.xyz/sign-up?utm_source=zdzui&utm_campaign=amb_readme) and register with your email, then verify it.
2. **Create a key.** Once signed in, open [Keys](https://zdzui.xyz/keys?utm_source=zdzui&utm_campaign=amb_readme), create a token and copy it (it is shown only once).
3. **Paste it back.** On the first-launch welcome screen choose "Paste API key". The app validates `GET /v1/models` and lists your models.

Top up on the [billing page](https://zdzui.xyz/billing?utm_source=zdzui&utm_campaign=amb_readme); usage, balance and keys live in the [console](https://zdzui.xyz/dashboard/overview?utm_source=zdzui&utm_campaign=amb_readme).

**How dazuibot uses this relay**

- **One key is all it takes.** The white-label build has no in-app account sign-in: paste an API key on first launch and the app remembers it. Same in Docker or on a server.
- **Every model, one picker.** Models your key can use are listed automatically. Reference prices come from the site's public price list; context length and capability tags come from the site's model-profile endpoint, which the site does not currently serve, so those two are not shown yet.
- **Pay for what you use.** Per-day usage shows up inside the app. Wallet balance and top-ups live on the site — the app only holds an API key and cannot read the account balance.
- **An honest boundary.** Model requests travel through this relay to the provider you pick, and the relay keeps request logs (the site states what and for how long). Everything else stays on your device ([details](#-how-it-works--privacy)).

---

# 📥 Download

Pick your platform. Every version ships with all installers and a `SHA256SUMS` file.

> Installers and `SHA256SUMS` are provided by the distributor; this repository does not publish build artifacts.

| Platform | Architecture | Installer |
| :--- | :--- | :--- |
| ![Windows][win-badge] | x64 | `anymodel-bot-<version>-win-x64.exe` |
| ![Windows][win-badge] | arm64 | `anymodel-bot-<version>-win-arm64.exe` |
| ![macOS][mac-badge] | Apple silicon | `anymodel-bot-<version>-mac-arm64.dmg` |
| ![macOS][mac-badge] | Intel | `anymodel-bot-<version>-mac-x64.dmg` |
| ![Linux][linux-badge] | x64 | `anymodel-bot-<version>-linux-x86_64.AppImage` |
| ![Linux][linux-badge] | arm64 | `anymodel-bot-<version>-linux-arm64.AppImage` |

<p align="center">
  <img src="docs/assets/download/install-windows.gif" alt="Installing dazuibot on Windows: run the installer, open the app, and land on the paste-your-API-key welcome screen" width="100%">
</p>

**First launch.** If your system warns about an app downloaded from the internet, choose *More info → Run anyway* on Windows, or *System Settings → Privacy & Security → Open Anyway* on macOS. On Linux, mark the AppImage as executable (`chmod +x`) and run it. Closing the window hides dazuibot to the tray; quit from the tray menu or from Settings.

**Verify a download.**

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

On macOS use `shasum -a 256 <file>`; in Windows PowerShell use `Get-FileHash <file>`. Compare the result with the line in `SHA256SUMS`.

**Run it in Docker on a NAS or server** (the image covers both x64 and arm64)

```bash
# image address is provided by the distributor (this repository publishes none); to build your own see "Run from source" below
docker run -d --name amb -p 3600:3600 -v amb-data:/data <image-address>
docker exec amb cat /data/ui-token   # then open http://<host>:3600/?token=<token>
```

Don't expose port 3600 directly to the internet.

**Run from source**

```bash
git clone <this-repository-url>
cd dazuibot
npm install
npm run setup      # fetches and builds the bundled gateway
npm start          # opens the local console at http://127.0.0.1:3600/
```

Requirements for building from source: Node.js 22.13+ and Go 1.26.8+. To build the Docker image yourself, see the [development guide](./docs/development_en.md).

# 🌠 Screenshots

These screenshots show the Simplified Chinese interface. The app also runs in English; switch in Settings.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/chat-dark.webp">
  <img src="docs/assets/screenshots/chat-light.webp" alt="Chat screen: a reply with a Markdown list and a code block, the model button in the composer, and the bot list on the left" width="100%">
</picture>

<p align="center"><i>Chat with a bot. Replies render Markdown and code, and the composer shows which model it is using.</i></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/agent-dark.webp">
  <img src="docs/assets/screenshots/agent-light.webp" alt="Agent screen: a step-by-step activity list for a file task and an approval card asking to write outside the workspace" width="100%">
</picture>

<p align="center"><i>Agent work is visible step by step. Anything outside the workspace waits for your approval.</i></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/models-dark.webp">
  <img src="docs/assets/screenshots/models-light.webp" alt="Model picker: a searchable list of models with reference prices" width="100%">
</picture>

<p align="center"><i>Pick any model per conversation. Reference prices sit next to each one.</i></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/memory-dark.webp">
  <img src="docs/assets/screenshots/memory-light.webp" alt="Info panel showing a bot's memory entries, connected channels and recent sessions" width="100%">
</picture>

<p align="center"><i>Memory, channels and sessions for each bot, in one panel.</i></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/bots-dark.webp">
  <img src="docs/assets/screenshots/bots-light.webp" alt="Six dazuibot characters in a row, each with its own color" width="100%">
</picture>

<p align="center"><i>Six characters to tell your bots apart. Their eyes follow your pointer.</i></p>

# 🌟 Key Features

## 🤖 Bots that do the work

A bot is more than a chat window: it has a persona, a default model, its own workspace and its own memory.

- **Make as many bots as you need**, each with its own persona, model, workspace and avatar.
- **You decide who it is.** A persona is just text, and templates are only a starting point. The six avatars change how a bot looks, not what it can do.
- **Real file work.** Bots read and write files, run commands in a sandbox, and send the results back to the chat as files.
- **Three permission presets per bot.** *Read-only*, *Workspace* (the default: write inside the bot's own folder, ask before anything outside) and *Full access* (no sandbox; recursive deletes still ask first).
- **Approval cards, not surprises.** Out-of-bounds actions stop and wait for your answer.
- **Told after a restart.** A message still in progress when the app quit or crashed is flagged in its conversation at the next start, so you can send it again; nothing is redone on its own.
- **Group chats.** Create a group and add a few bots. Whoever you @ answers; with no @, the bot that answered last carries on. Bots can also @ another member to hand off. Each bot keeps its own model, workspace and memory, and costs are tracked per bot.
- **Slash commands** such as `/model` and `/reset` work in the app and in every chat channel. In a chat channel, `/bot` switches to another bot.

<p align="center">
  <img src="docs/assets/features/agent-files.gif" alt="A bot tidies a messy folder: it lists the files, proposes a plan, and an approval card asks before moving files outside its workspace" width="100%">
</p>

## ⏳ Works in the background, and comes to you only when needed

- **Background tasks.** For work that takes a while (research, a report, sorting files), or when you say "do it in the background", the bot starts a background task and you keep chatting. The result comes back to the conversation that asked for it.
- **Follow-ups.** Quote the result in WeChat, or reply to it in Feishu, to keep talking to that task.
- **Rules.** "Every morning at 8, check X's price and tell me if it drops below 200" becomes a rule that checks on schedule and tells you only when something matters. To see how it behaves first, say "observe first": it records what it would have said, and sends nothing and changes no files. Once it looks right, switch it to act.
- **Needs you.** Everything any bot is waiting on you for, an answer, an approval or a retry, sits in one sidebar row that is only there when something needs you. The info panel's Tasks group lists the bot's tasks and rules, with every step visible.
- **Quiet by default.** Only results, decisions and failures are pushed, never progress. Quiet hours are 22:00 to 08:00, and unprompted messages are capped per day (3 on WeChat, 5 on other channels), with the rest merged into one.
- **Budgets.** Every task and rule has a budget (1 US dollar per task; 0.10 per rule run and 3 a month), and work stops and asks when it runs out. Change them in the task details and the rule editor.
- **Pause anytime.** One switch in bot settings › Proactive messages pauses background work; chat carries on.
- **Cleans up after itself.** Tasks and run logs are kept for 30 days. A task folder unused for 30 days is deleted without asking; the task details show the date, and Keep holds on to it. Run logs export as Markdown.

The full story, in Chinese: [dazuibot 超级智能体](./docs/blog/superagent.md).

## 🖥️ Operates your computer, and makes images and video

- **Computer use** is powered by the bundled [Cua Driver](https://github.com/trycua/cua). By default, actions run automatically. Switch a bot to *ask before changing the screen* and every click and keystroke waits for you. Reading the screen never needs approval. On macOS, computer use is a Beta feature.
- **Image and video generation** runs right away, taking the most reasonable reading of a loose request. It asks first only when the estimated cost is above 0.50 US dollars, so you see the model and prompt and can swap the model on the spot. To be asked every time, turn it on in the bot's settings.

<p align="center">
  <img src="docs/assets/features/computer-use.gif" alt="A bot opens Notepad, types a short note and saves it, while an approval card asks before each click and keystroke" width="100%">
</p>

<p align="center">
  <img src="docs/assets/features/media-generation.gif" alt="A bot asks which model to use for an image, the user confirms, and the finished image arrives in the chat as a file and opens in a viewer" width="100%">
</p>

## 🌐 Any model, through this relay

- **One key is enough** and the models your key can use appear automatically.
- **One picker for everything.** GPT, Claude, Gemini, Grok, DeepSeek, Kimi, GLM and more, each with a reference price whenever one can be computed.
- **Switch per conversation** or set a default per bot. Background chores such as tidying memory and context hand-offs can use a separate model of their own.
- **One route.** The white-label build points at a single relay address: there is no international/mainland pair and no automatic switching.
- **Pay per use.** Daily usage and per-bot budgets live in the app; wallet balance and top-ups live on the site. dazuibot has no subscription.

<p align="center">
  <img src="docs/assets/features/first-run.gif" alt="First launch: paste an API key, return to the app with models listed, and send a first message" width="100%">
</p>

<p align="center">
  <img src="docs/assets/features/model-switch.gif" alt="Opening the model picker, searching for a model, reading its context length and reference price, and switching the conversation to it" width="100%">
</p>

## 🧠 Memory, and reachable from anywhere

- **Memory that carries over.** Bots keep Markdown memory at three levels (team, bot and group) and filter out anything that looks like a secret.
- **Long chats stay usable.** A context steward compacts or starts a fresh segment with a hand-off summary before the window fills up.
- **Accounts shared by all bots.** Add WeChat, Feishu, Telegram, Slack, Discord and Notion accounts once in Settings. Every bot shares them, and each service can have several accounts with aliases. Send `/bot name` once in a chat app to talk to a different bot, or let a bot read your Notion and Feishu messages.
- **WeChat and Feishu.** Scan a QR code to connect WeChat, or connect a Feishu bot with streaming reply cards. WeChat also carries images and files.
- **Telegram, Slack and Discord.** Paste a token in Settings › Connections. No public address needed. Replies appear as they're written, and images and files work both ways. Direct messages only for now, and approvals and questions are answered by text.
- **Four ways to run it.** Desktop app, command line, Docker, or the local web console at `127.0.0.1:3600`.

<p align="center">
  <img src="docs/assets/features/memory.gif" alt="Telling a bot to remember a preference, opening the info panel to see the new memory entry, then starting a new chat where the bot uses it" width="100%">
</p>

<p align="center">
  <img src="docs/assets/features/channels-wechat.gif" alt="Scanning a QR code to connect WeChat, sending a question from the phone, and the bot answering on the phone while the conversation shows up under Recent sessions in the desktop app" width="100%">
</p>

## 🔒 Local-first, and easy on the eyes

- **Your data stays with you.** Conversations, memory, files and API keys are stored on your device. The local console listens on `127.0.0.1` only, and the desktop app generates a fresh access token on every launch.
- **It answers to you.** By default a bot replies only to its owner (the WeChat account that scanned the QR code; on Feishu, Telegram, Slack and Discord, the first person to message it after you connect it, which is you) and the people you allow. Anyone else gets a one-line notice and no model is called; you let them in from the info panel, or by replying `yes <code>` in chat.
- **Replies are not lost.** A reply is saved locally before it is sent; network errors are retried, sending resumes after a restart, and when WeChat's 24-hour window has closed the reply waits and arrives with your next message.
- **Telemetry kept off.** Telemetry in the bundled computer-use driver is switched off, and the built-in gateway runs with auto-update disabled.
- **Light, dark or follow the system.** Six bot characters, and their eyes follow your pointer.
- **Tray and autostart.** Close the window to hide to the tray; autostart is available on macOS and Windows.

<p align="center">
  <img src="docs/assets/features/characters-eyes.gif" alt="Six dazuibot characters in a row; their eyes follow the pointer as it moves across them" width="100%">
</p>

> [!NOTE]
> Features depend on the model you choose, your operating system and the permissions you grant. Computer use requires a desktop session, and macOS computer use is in Beta. Model requests go through this relay to the provider you pick; see [How it works & privacy](#-how-it-works--privacy).

# 🆚 dazuibot vs Grok Bot, OpenAI dots and Claude Duet

In the second half of 2026, xAI's [Grok Bot](https://x.ai/bot), OpenAI's [dots](https://openai.com/index/introducing-dots/) and Anthropic's Claude Duet made the always-on personal AI agent the thing to watch: it keeps an eye on things, works in the background and comes to you when a decision is yours. dazuibot does the same kind of job a different way: open source, on your own device, with any model.

| | dazuibot | Grok Bot | OpenAI dots | Claude Duet |
| :--- | :--- | :--- | :--- |
| Open source | ✅ MIT | — | — |
| Where the agent runs | Your own computer or server | xAI's cloud computer | OpenAI's cloud computer | Anthropic's cloud |
| Models | GPT, Claude, Gemini, Grok, DeepSeek, Kimi, GLM and more, 68 in total (through this relay) | Mainly xAI's Grok models | OpenAI's models | Claude (Opus 5.5) |
| Cost | Free app, models billed per token | Subscription | ChatGPT Pro / Business Premium subscription | Claude Pro / Max subscription |
| Where you reach it | Desktop app (Windows, macOS, Linux), Docker, WeChat, Feishu, Telegram, Slack, Discord | Desktop app, iPhone | ChatGPT, Slack, Teams | iOS, Android, claude.ai |
| Availability | Download it now | Beta | Select markets | Research preview, US waitlist |

dazuibot works in the background too: a task you hand over can finish in the background and send its result to your chat app, and anything that needs your approval or answer shows up under "Needs you" in the sidebar. Every step a bot takes is visible, and anything outside its workspace asks you first.

> [!NOTE]
> Details about the other products come from public reports as of October 2026 and may have changed; check each vendor's official information. Grok Bot, dots and Claude Duet are products and trademarks of xAI, OpenAI and Anthropic respectively. dazuibot is not affiliated with them.

# 🔐 How it works & privacy

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/diagrams/data-flow-dark.svg">
  <img src="docs/assets/diagrams/data-flow-light.svg" alt="Data flow: conversations, memory, files and keys stay on your device; model requests go through this relay to the model provider; chat channel messages pass through those platforms, and bots read and write the Notion and Feishu accounts you authorize" width="100%">
</picture>

| Stays on your device | Leaves your device |
| :--- | :--- |
| Conversations and sessions (local SQLite database) | The prompts, files and tool results a model needs to answer, sent through this relay to the provider you chose |
| Memory (Markdown files) | Screenshots, when you ask a bot to look at your screen with computer use |
| Files in each bot's workspace | Messages you exchange over chat channels, which pass through those platforms |
| Your API key | Your sign-up and key creation on zdzui.xyz, which happens on that site |
| Settings | If you add Notion or Feishu accounts, bots read and write in those accounts, and what they read also goes into model requests |

This relay keeps request logs; what is kept and for how long is stated by the site. We do not claim your data is beyond all risk: anything you send to a model leaves your device. The full inventory is in [docs/privacy_en.md](./docs/privacy_en.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/diagrams/architecture-dark.svg">
  <img src="docs/assets/diagrams/architecture-light.svg" alt="Architecture: Electron shell, command line or Docker start a Node.js and TypeScript backend with a Preact UI, SQLite, the DSH agent runtime and channel adapters, which call the bundled magpie gateway, which calls this relay" width="100%">
</picture>

| Layer | Technology |
| :--- | :--- |
| Interface | Preact + htm, no build step |
| Backend | Node.js 22.13+, TypeScript, `node:sqlite` |
| Desktop shell | Electron, with a tray |
| Model gateway | [magpie](https://github.com/yetone/magpie) (Go, MIT), bundled and started by the app |
| Agent runtime | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT), run as a separate process |
| Computer use | [Cua Driver](https://github.com/trycua/cua), bundled |
| Channels | Feishu (long connection + streaming cards), WeChat (iLink), Telegram (long polling), Slack (Socket Mode), Discord (Gateway) |
| Data accounts | Notion (REST API, official remote MCP), Feishu messages (user identity, read-only) |
| Tests and CI | Vitest, GitHub Actions |

# 📝 Roadmap

Directions we are exploring. They are not promises, and the order is not a schedule. For what changed in each version, see the [changelog](./CHANGELOG_en.md).

- [x] **Scheduled tasks**: let a bot run work on a timer (shipped as rules, above).
- [x] **In-app group chats**: create a group in the app and chat with several bots at once.
- [ ] **Group chats on chat channels**: chat channels handle one-to-one chats today.
- [x] **English interface**: the app runs in English and Simplified Chinese; switch in Settings.
- [ ] **macOS computer use**: verify direct mode on more real machines and move it out of Beta.
- [ ] **Email, calendar and event triggers**: connect email and calendar accounts, and let rules run the moment something happens (a message from a certain person, a meeting about to start), not only on a timer. Runs triggered by outside content get lower permissions, so text written by someone else can't give your bot orders.
- [ ] **Always-on hosting, backup and migration**: rules don't run while your computer is off. Make it possible for anyone to deploy to their own server in one click, move their chats, memory and accounts over, and back up and restore.
- [ ] **Add your own MCP servers**: today you can only use the built-in tools and accounts. Opening this up lets you connect services like GitHub and Linear yourself.
- [ ] **Bots working together**: let one bot hand work to another, for example drafting and reviewing with different models, with costs tracked separately.
- [ ] **Voice message transcription**: bots can't hear Telegram voice messages today, and WeChat relies on the platform's own transcript.
- [ ] **A standalone mobile app**: today you reach your bots from WeChat, Feishu, Telegram, Slack or Discord.

Have a different idea? Tell the distributor.

# 🛠️ Building it yourself

```bash
npm install
npm run setup          # fetches and builds the bundled gateway
npm run electron:dev   # desktop app in development mode
npm run typecheck && npm test
```

Changes are described in [docs/development_en.md](./docs/development_en.md). To report a security problem, follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.

# 🔗 Related Projects

- [magpie](https://github.com/yetone/magpie): the Go gateway bundled with the app (MIT).
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the agent runtime (MIT).
- [Cua](https://github.com/trycua/cua): the computer-use driver.
- [kimi-computer-use](https://github.com/songkeys/kimi-computer-use): the macOS computer-use bridge.
- [openclaw-weixin](https://github.com/Tencent/openclaw-weixin): the WeChat channel we ported from (MIT).
- [DS Bot](https://github.com/Fei2411/DS-Bot): the design source for our memory and context steward (Apache-2.0).

Full licenses and notices: [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

# 📜 License

dazuibot is released under the [MIT License](./LICENSE). Bundled third-party software keeps its own licenses; see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and the [`LICENSES/`](./LICENSES) folder.

<!-- link & badge references -->
[license-shield]: https://img.shields.io/badge/license-MIT-d7ff00?style=flat-square&labelColor=161a00
[platform-shield]: https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Docker-d7ff00?style=flat-square&labelColor=161a00
[pricing-shield]: https://img.shields.io/badge/pricing-pay--as--you--go-d7ff00?style=flat-square&labelColor=161a00
[win-badge]: https://img.shields.io/badge/Windows-161a00?style=for-the-badge&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI2Q3ZmYwMCI+PHJlY3QgeD0iMiIgeT0iMyIgd2lkdGg9IjkuNSIgaGVpZ2h0PSI4LjUiLz48cmVjdCB4PSIxMi41IiB5PSIzIiB3aWR0aD0iOS41IiBoZWlnaHQ9IjguNSIvPjxyZWN0IHg9IjIiIHk9IjEyLjUiIHdpZHRoPSI5LjUiIGhlaWdodD0iOC41Ii8+PHJlY3QgeD0iMTIuNSIgeT0iMTIuNSIgd2lkdGg9IjkuNSIgaGVpZ2h0PSI4LjUiLz48L3N2Zz4=
[mac-badge]: https://img.shields.io/badge/macOS-161a00?style=for-the-badge&logo=apple&logoColor=d7ff00
[linux-badge]: https://img.shields.io/badge/Linux-161a00?style=for-the-badge&logo=linux&logoColor=d7ff00

[pricing-link]: https://zdzui.xyz/pricing?utm_source=zdzui&utm_campaign=amb_readme
