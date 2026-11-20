# Changelog

[简体中文](./CHANGELOG.md) | English

This covers changes you'll notice in the app. Earlier versions belong to upstream AnyModelBot's history and are not part of this distribution.

## Unreleased

### New

- **The web workspace now has an automated end-to-end check:** `npm run e2e:web` drives a headless Chrome through the whole flow — sign in, create a team, create a bot, create a conversation, connect a model, send a message, set the model policy, pick a model as a member, render every tab, and assert the browser console is clean. The check used to live only in a scratch directory on one machine; it is now in the repository, in CI, and in the deployment package.
- **The web workspace can show "policy alerts" and "policy usage":** team owners and admins can now see rejected requests, a breakdown of why they were rejected, the most-used models, and the heaviest users, without digging through logs. Regular members only see alerts that concern them, never the whole team's picture.
- **You can spin up a team service locally to try the web workspace:** `npm run dev:web` starts an embedded team service on your machine (data lives in the system temp directory). Open http://127.0.0.1:8790/ in a browser and you get the full team workspace — the same code path the desktop app uses in embedded mode.

### Fixed

- **The web acceptance script in the deployment package couldn't run on the deploy machine:** the script referenced `src/embedded.js`, but the source is TypeScript — there's only `src/embedded.ts`. During development it always ran under `tsx`, which maps `.js` back to `.ts`, so the problem stayed hidden; on a deploy machine you're on plain `node`, and the package deliberately ships source without compiled output, so it always failed with "cannot find module". Both ways of running it work now — unpack the package and `node scripts/web-e2e.mjs` re-runs the whole web acceptance suite.
- **Two local team services no longer clobber each other:** the local acceptance script wiped its data directory on every start, so two instances running at once would delete each other's database. The data directory is now separated per process.
- **Alert badges didn't show severity:** the "rejected" and "alert" badges all looked identical — grey on grey — so there was no way to tell which one mattered. They're now split into red (critical), yellow (warning), and grey (info).
- **Scripts that ship inside the deployment package weren't tested:** the packaging script and the local acceptance script sit outside test coverage, so a missing import in them only shows up when you actually run them — which is exactly how the acceptance script ended up missing `node:path` and failing on first use. Two checks now guard this: one statically verifies the imports are all there, and one actually starts the service and waits for it to report "团队服务已启动".

## 1.0.0-zdzui.3 - 2026-11-20

### New

- **Code tasks now run for real in a cluster:** the whole chain — dispatch, approval, pulling the repository snapshot, running the AI edit inside a container, reporting the change back, and landing the branch and diff — has been verified end to end in the k3s cluster. This is the first hard evidence for the "real DSH runner" gap.

### Fixed

- **No way to configure a model from the browser:** the desktop app lets you enter a model id and API key, but the web workbench had no equivalent, so team messages were rejected by the server ("the team model is not configured") with nowhere on the page to fix it. The web workbench now has a "Model access" tab where owners and admins can set the model or rotate the key.
- **The "specific models" allowlist mode was unusable:** the allowed models could only be picked from the deployment catalog. With an empty catalog there was nothing to pick, and saving was rejected by the server. You can now type model ids directly (comma separated); picked and typed models are merged. The input appears as soon as you switch to that mode.
- **Members had no way to pick their own model:** the dropdown was empty when no models were available. There is now a free-text field next to it.
- **Creating and deleting on the web interrupted you:** creating a bot or a conversation popped a system dialog, and deleting a rule popped a system confirm box. In a browser these break your flow. They are now inline inputs and a two-click confirm.
- **Repository snapshots were wrongly flagged as unsafe:** GitHub's code tarballs carry an outer directory (like `Hello-World-master/`). Strip that one level and it becomes an empty path, which the safety check read as a path traversal — so every real GitHub repository was rejected before unpacking, and code tasks could never start. The top-level directory entry is now allowed, while all entries must still sit under a single top-level directory (so mixed-in directories can't sneak in).
- **Code task containers couldn't create a git repo:** the executor container runs as a non-root user, but the workspace is an emptyDir mount owned by root, so `git init` failed with Permission denied and `git config` then reported "not in a git directory". The Pod now sets fsGroup, so the volumes are mounted with the runtime user's group and the container can create `.git`.
- **Git refused to operate in the workspace:** same cause — the workspace is owned by root while git runs as a different uid, and git's "dubious ownership" protection declines to treat it as a repository. The workspace is now explicitly registered as a safe directory.
- **Code task queue timing on real PostgreSQL:** when deciding whether a job could be picked up, the clock used for the check wasn't the same one used when writing the job (they differ by less than a millisecond, plus network latency between the database and the app), so a freshly dispatched job was judged "not due yet". Both sides now use the database's own clock.

## 1.0.0-zdzui.2 - 2026-11-19

### New

- **Cross-process revocation now has an end-to-end drill:** the drill starts a second, independent client (its own data directory, its own encrypted session file) and uses it to revoke the first client's permissions, verifying that all four paths take effect immediately — session revoked, member removed, role demoted to read-only, and member leaving the team. The most important one: a removed member's queued jobs really are cancelled, rather than sitting in the queue for the backend to spend the model key on. The drill has 40 steps and now runs in CI.
- **The infinite canvas can generate images:** a generation bar now sits above the canvas. Write what you want (for example "a black cat sitting by a window") and the result becomes an image node on the canvas — you can connect it, drag it, and export it like any other node. When the site is not connected yet, it says so plainly instead of leaving you staring at an opaque error.
- **Extra restrictions on top of model access:** the team creator can now add rules on top of the access range — block a model, cap requests per hour per person, cap daily tokens, or apply a rule only to read-only members. These rules apply on top of the existing range: as soon as one is hit, the request is rejected. Rejected requests are recorded and visible in both the browser workspace and the desktop app, showing who was blocked and on which model.
- **Browser-based team workspace:** the team service now ships its own web interface, so you can join a team from a browser without installing the desktop app. Open the team service address with `/` (or `/app`, `/web`) to sign in, join a team, post messages, invite members, adjust the model access range and extra restrictions, and check usage and audit records. The page is served with a strict content security policy (scripts use a one-time token, and no external resources are loaded).
- **Infinite canvas:** open it from the bottom of the sidebar or the command palette. Drop text, shape, and image nodes on the canvas and connect them with lines; drag empty space to pan and scroll to zoom. The canvas is stored on this machine and can be exported as a JSON file for backup or sharing.

### Fixed

- **There were two copies of the archive check for code tasks:** the unit tests covered one copy, while the copy actually running in the container was a different one — so what was tested was not what was running. The one that runs is now generated from the one that is tested, so the two cannot drift apart. If you change the archive safety logic, the test will stop you if you forget to regenerate.
- **The canvas page laid out wrongly when a notice appeared:** the canvas used a fixed number of grid rows, so any missing row — toolbar, notice, generation bar, inspector — pushed the canvas into the wrong row. It now uses a flexible column and the canvas fills the remaining space.
- **Web sign-in said "try again later":** pressing "Send code" and then "Sign in" made the sign-in flow request a second code, which hit the 60-second per-email cooldown and failed. Sign-in now uses the code that was already issued.
- **Updating "last seen" during sign-in failed on a real database:** the time subtraction in that SQL was parsed as "parameter minus an interval", producing an interval instead of a timestamp. It did not fail on the embedded database — only on real PostgreSQL. The value is now explicitly cast to a timestamp.

- **Team messages sometimes never got sent:** a message posted in team chat could sit at "waiting for cloud AI" forever, and retrying did not help. The check for whether a queued job was due used a different clock from the one that wrote it (a sub-millisecond difference, plus network latency because the app and the database run on different machines), so a just-posted message was judged "not due yet". The database's own clock is now used consistently, so a message is picked up as soon as it is posted.

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
