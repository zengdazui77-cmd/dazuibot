// anymodel bot: "ask before a plugin runs a tool" gate for user-installed plugins (MIT, part of anymodel bot).
//
// Plugins from Settings > Plugins are MCP servers mounted as `plg-<id>`; their tools are named
// `mcp__plg-<id>__<tool>`. The host lists in AMB_PLUGIN_ASK (a JSON array of server names) the plugins whose
// tool calls need the user's approval: those set to "ask first", and every plugin on a read-only bot. Each
// such call becomes a normal DSH approval request, which amb-bridge routes to the chat. The host loads this
// plugin only when that list is not empty.
export const name = 'amb-plugin-gate'

const PREFIX = 'mcp__'

export function apply(ctx) {
  let servers = []
  try {
    const parsed = JSON.parse(process.env.AMB_PLUGIN_ASK ?? '[]')
    if (Array.isArray(parsed)) servers = parsed.map(String)
  } catch {}
  if (!servers.length) return
  const prefixes = servers.map((s) => `${PREFIX}${s}__`)
  ctx.on('tools/pre-execute', async (exec, next) => {
    const tool = String(exec?.name ?? '')
    const prefix = prefixes.find((p) => tool.startsWith(p))
    if (!prefix) return next()
    const downstream = await next()
    if (downstream?.kind !== 'allow') return downstream
    const plugin = prefix.slice(PREFIX.length, -2).replace(/^plg-/, '')
    const action = tool.slice(prefix.length)
    return {
      kind: 'ask',
      reason: `Plugin "${plugin}" wants to run "${action}" (this plugin asks before each tool call)`,
      displayReason: { en: `Plugin ${plugin}: ${action}`, zh: `插件 ${plugin}：${action}` },
    }
  }, { prepend: true })
}
