FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates git tar \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 65532 runner \
  && useradd --system --uid 65532 --gid 65532 --home-dir /home/runner --create-home runner

WORKDIR /opt/dazuibot/dsh-runtime
COPY dsh-runtime/package.json dsh-runtime/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && helper="node_modules/node-pty/prebuilds/linux-x64/spawn-helper" \
  && if [ -f "$helper" ]; then chmod 0755 "$helper"; fi
COPY dsh-runtime/plugins ./plugins
RUN node --input-type=module -e "import('./node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js').then(m => { if (typeof m.DeepSeekHarness !== 'function') throw new Error('DeepSeekHarness export missing'); })"

COPY team-service/executor/run-task.mjs /opt/dazuibot-executor/run-task.mjs
# archive.mjs 是 src/archive.ts 的转译产物（见 build-archive.mjs）：
# runner 的归档安全检查必须用被单测覆盖的那份代码，不能在 runner 里另写一遍。
COPY team-service/executor/archive.mjs /opt/dazuibot-executor/archive.mjs
RUN node --check /opt/dazuibot-executor/run-task.mjs \
  && node --check /opt/dazuibot-executor/archive.mjs \
  && chown -R 65532:65532 /opt/dazuibot /opt/dazuibot-executor /home/runner

USER 65532:65532
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/dazuibot-executor/run-task.mjs"]
