import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateTarListing, validateTarVerboseListing } from './archive.mjs'

const exec = promisify(execFile)
const marker = 'DAZUIBOT_RESULT:'
const envelope = JSON.parse(process.env.TEAM_TASK_ENVELOPE || '{}')
const api = String(envelope.brokerUrl || '').replace(/\/$/, '')
const capability = envelope.capabilityToken
const jobId = envelope.jobId
const model = envelope.model
const targetBranch = envelope.branch
const workspace = '/workspace'
const archive = '/tmp/team-task.tar.gz'
const home = '/home/runner/dsh'

function bounded(value, length) {
  return String(value ?? '').replaceAll(capability, '[task capability redacted]').slice(0, length)
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), 'x-executor-capability': capability, accept: 'application/json' },
    redirect: 'error',
    signal: options.signal,
  })
  return response
}

async function snapshot() {
  const response = await apiRequest(`${api}/v1/internal/code-tasks/${encodeURIComponent(jobId)}/snapshot`)
  if (!response.ok) throw new Error(`repository snapshot request failed: HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > 50 * 1024 * 1024) throw new Error('repository snapshot size is invalid')
  await writeFile(archive, bytes, { mode: 0o600 })
  // 归档检查用 archive.mjs 里那份被单测覆盖的实现，不要在这里另写一份：
  // 两份逻辑一旦不一致，被测过的就不是真正跑着的那份。
  const verbose = await exec('tar', ['--list', '--verbose', '--quoting-style=escape', '--gzip', '--file', archive], { maxBuffer: 2 * 1024 * 1024 })
  validateTarVerboseListing(verbose.stdout)
  const listing = await exec('tar', ['--list', '--gzip', '--file', archive], { maxBuffer: 2 * 1024 * 1024 })
  validateTarListing(listing.stdout)
  await exec('tar', ['--extract', '--gzip', '--file', archive, '--strip-components=1', '--no-same-owner', '--no-same-permissions', '--directory', workspace], { maxBuffer: 2 * 1024 * 1024 })
}

function providerPatch() {
  const base = `${api}/v1/internal/code-tasks/${encodeURIComponent(jobId)}/model`
  return [
    '- id: llm-pi-ai', '  config:', '    providers:',
    '      team-proxy:', '        displayName: team-proxy', '        api: openai-completions',
    `        baseURL: ${JSON.stringify(base)}`, '        apiKeyEnv: DAZUIBOT_MODEL_PROXY_KEY',
    '        models:', `          - id: ${JSON.stringify(model)}`, `            name: ${JSON.stringify(model)}`, '            contextWindow: 128000', '            maxTokens: 8192',
    '- id: bash-sandbox', '  config:', '    timeoutMs: 30000', '    maxTimeoutMs: 60000',
    '- id: web', '  disabled: true',
    '- id: tool-web', '  disabled: true',
    '- id: tool-subagent', '  disabled: true',
    '- id: tool-subagent-fork', '  disabled: true',
    '- id: system-prompt', '  config:', '    includeHarnessIdentity: false',
    '',
  ].join('\n')
}

async function runDsh(abortSignal) {
  if (!model) throw new Error('the team has not configured a model for this task')
  const runtime = process.env.DSH_RUNTIME_DIR || '/opt/dazuibot/dsh-runtime'
  const sdk = await import(pathToFileURL(path.join(runtime, 'node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js')).href)
  await mkdir(home, { recursive: true, mode: 0o700 })
  const patch = path.join(home, 'team-task.patch.yml')
  await writeFile(patch, providerPatch(), { mode: 0o600 })
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8',
    DSH_PERMISSION_MODE: 'danger-full-access', DAZUIBOT_MODEL_PROXY_KEY: capability,
  }
  const harness = new sdk.DeepSeekHarness({ profile: 'sdk', patches: [patch], dshHome: home, env, cwd: workspace, processCwd: workspace, provider: 'team-proxy', model, initializeTimeoutMs: 120_000, shutdownTimeoutMs: 3_000 })
  let stopping = false
  const stop = async () => { stopping = true; await harness.close().catch(() => {}) }
  abortSignal.addEventListener('abort', () => { void stop() }, { once: true })
  try {
    await harness.start()
    const prompt = [
      'You are running one approved team code task inside an isolated workspace.',
      'Work only in the current workspace. Do not access credentials, the host, or other projects.',
      'Inspect the repository, make the requested local changes, and run bounded relevant checks.',
      `Task instructions:\n${envelope.instructions}`,
      `Target branch for the eventual review: ${envelope.branch}`,
    ].join('\n\n')
    const result = await harness.session('code-task').run(prompt)
    if (stopping) throw new Error('task stopped by the control plane')
    return bounded(result?.finalResponse || 'DSH completed without a final response', 12_000)
  } finally {
    await harness.close().catch(() => {})
    abortSignal.removeEventListener('abort', stop)
  }
}

async function initializeGit() {
  await exec('git', ['init', '--initial-branch', `dazuibot-base-${jobId.replace(/[^A-Za-z0-9_-]/g, '')}`], { cwd: workspace, maxBuffer: 64 * 1024 })
  await exec('git', ['config', 'user.name', 'Dazuibot Code Task'], { cwd: workspace })
  await exec('git', ['config', 'user.email', 'code-task@localhost'], { cwd: workspace })
  await exec('git', ['add', '--all'], { cwd: workspace, maxBuffer: 2 * 1024 * 1024 })
  await exec('git', ['commit', '--allow-empty', '-m', 'Task snapshot baseline'], { cwd: workspace, maxBuffer: 256 * 1024 })
  if (targetBranch !== `dazuibot-base-${jobId.replace(/[^A-Za-z0-9_-]/g, '')}`) {
    await exec('git', ['switch', '--create', targetBranch], { cwd: workspace, maxBuffer: 64 * 1024 })
  }
}

async function collectDiff(summary) {
  await exec('git', ['add', '--all'], { cwd: workspace, maxBuffer: 2 * 1024 * 1024 })
  const [status, patch] = await Promise.all([
    exec('git', ['status', '--short'], { cwd: workspace, maxBuffer: 256 * 1024 }),
    exec('git', ['diff', '--cached', '--binary', '--no-ext-diff', 'HEAD'], { cwd: workspace, maxBuffer: 4 * 1024 * 1024 }).catch((error) => ({ stdout: error.stdout || '', stderr: '' })),
  ])
  const rawDiff = patch.stdout || ''
  const maxDiffBytes = 15_000
  const diff = Buffer.byteLength(rawDiff, 'utf8') > maxDiffBytes ? Buffer.from(rawDiff, 'utf8').subarray(0, maxDiffBytes).toString('utf8') : rawDiff
  return {
    outcome: 'succeeded',
    branch: targetBranch,
    summary: bounded(summary, 2_000),
    changedFiles: status.stdout.split(/\r?\n/).filter(Boolean).slice(0, 200).map((line) => line.replaceAll(capability, '[task capability redacted]')),
    diff: diff.replaceAll(capability, '[task capability redacted]'),
    diffTruncated: diff.length < rawDiff.length,
  }
}

const controller = new AbortController()
try {
  await rm(workspace, { recursive: true, force: true })
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  await snapshot()
  await initializeGit()
  const result = await runDsh(controller.signal)
  const report = await collectDiff(result)
  console.log(`${marker}${JSON.stringify(report)}`)
} catch (error) {
  console.log(`${marker}${JSON.stringify({ outcome: 'failed', error: error instanceof Error ? error.message : 'sandbox task failed' })}`)
  process.exitCode = 1
} finally {
  controller.abort()
  await rm(archive, { force: true }).catch(() => {})
}
