# Changelog

[简体中文](./CHANGELOG.md) | English

This covers changes you'll notice in the app. Earlier versions belong to upstream AnyModelBot's history and are not part of this distribution.

## 1.0.0-zdzui.1 - 2026-11-03

Custom build for this site, based on upstream AnyModelBot (MIT).

### New

- **See every model if you want to:** Models that obviously can't chat (image generation, embeddings, speech-to-text, moderation) are tucked away by default, so they no longer crowd the list. A "Show all models" switch at the top of the list brings them back with a "may not support chat" marker, so you can decide for yourself. That switch is remembered on this computer.
- **Pricing failures speak up:** When pricing can't be fetched you see "Pricing is unavailable right now" with a retry button instead of a blank area.

### Changed

- **Connect with an API key only:** Account sign-in is gone. Paste the API key your site issued in Settings and you're set. The key lives only on this computer; if you suspect it leaked, delete it in the site dashboard and issue a new one.
- **Computer use is off by default:** First-time setup asks once whether to turn it on. Once on, actions that change the screen (clicking, typing) ask you first; just reading the screen doesn't interrupt.
- **No guessing numbers:** If the balance can't be fetched you see "Balance unavailable" with retry and a link to key management; a dead network says "Network not responding". No more dash that looks like zero.
- **Prices are indicative:** They come from the site's public pricing catalog and are for reference only — your bill is what counts.
- **Every link points at this site:** Sign-up, top-up, key management, pricing and docs all go to this site, not the upstream project.

## 0.1.16 - 2026-11-02

### New

- **Group chats:** With two or more bots, click ＋ in the sidebar to create a group chat and talk to several bots at once. Whoever you @ answers; with no @, the bot that answered last carries on. Bots can also @ another member to hand off. Each bot keeps its own model, workspace and memory, and costs are tracked per bot.

### Changed

- **Balance stays out of the way:** The bottom-left corner now shows only your avatar, name and the settings button. Click the avatar to see your balance and top up. You still get a sidebar reminder when your balance drops below the alert level.

## 0.1.15 - 2026-11-02

### New

- **Accounts shared by all bots:** Add chat and Notion accounts once in Settings › Connections, and every bot can use them. Each service can have several accounts, each with its own alias.
- **Switch bots from a chat:** Send `/bot` in a chat app to see your bots, and `/bot name` once to switch. That chat stays with the new bot, so you don't repeat it on every message. Each bot also knows about the others, so it can answer when you ask.
- **Telegram, Slack and Discord:** Paste a token to connect. No public address needed, and images and files work both ways.
- **Notion:** Connect with one-click authorization or a token. Bots can search, read, create and edit pages, and query databases. They can't delete pages.
- **Read Feishu messages:** Authorize with a QR code, then ask any bot to "check my second Feishu". It reads chats and searches messages as you, read-only.
- **Add Feishu by scanning:** When adding a Feishu chat account, scan a QR code to create the app instead of entering an App ID and Secret.

### Improved

- **Web search no longer needs a DeepSeek key:** It's free by default, and you can switch to Tavily, Exa, Bocha, Zhipu or your own SearXNG.
- **Characters are separate from roles:** An avatar only sets a bot's looks, and picking a template doesn't change it.

### Changed

- Chat channel setup moved from each bot's info panel to Settings › Connections. Existing accounts move over automatically with no new sign-in, and the same bot still answers by default.
- Owners and allow lists now belong to the account, so anyone allowed on it can talk to any bot. Deleting a bot no longer affects accounts.
