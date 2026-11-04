/**
 * Read-only mode — Host half.
 *
 * The switch is per session and lives in memory (Map/Set keyed by session id).
 * Enforcement is a plugin-wide `ctx.tools.guard()`: it runs for every tool call,
 * so flipping the switch takes effect on the very next call, and because a guard
 * has no "allow" result it cannot be overridden by listener ordering.
 *
 * Classification is fail-closed: only tools on the read allowlist below run while
 * the switch is on. Anything not proven to be a read is denied, which is the only
 * way to honour "不进行任何写入操作" without silently leaking new writer tools.
 */

export const name = 'dsh-readonly-mode'

export const inject = ['tools']

/** RPC channel shared with the Client half. */
export const CHANNEL = '/dsh-readonly-mode'

/**
 * Tools that only read. Everything outside this set (and the two argument-aware
 * families below) is refused while read-only mode is on.
 */
const READ_TOOLS = new Set([
  // Filesystem / workspace inspection
  'read',
  'grep',
  'glob',
  'read_image',
  // Web / search
  'web_search',
  'web_fetch',
  'read_page',
  'x_search',
  // Session introspection
  'skill',
  'ask_user_question',
  'get_goal',
  'list_agents',
  'job_list',
  'job_output',
  'compress',
  'decompress',
  'search_context',
  'acp_status',
  'acp_cache',
  'acp_read_original_image',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'load_workspace_dependencies',
  // Resources
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  // Univer: inspection only (write/export/import variants are not listed)
  'univer_status',
  'univer_inspect',
  'univer_lint',
  'univer_screenshot',
  'univer_api',
  // Blender: command catalogue + viewport frame only
  'blender_rt_commands',
  'blender_rt_see',
])

/**
 * Tools whose read/write nature depends on their arguments. A predicate returning
 * true means "this particular call only reads".
 */
const ARGUMENT_SCOPED = new Map([
  // Changing the working directory mutates session state, so only the plain read is allowed.
  ['working_directory', (args) => args === undefined || args === null || args.cd === undefined || args.cd === null],
  // Viewport backend: status/doctor/who are read-only; start/stop/restart/lease write.
  ['blender_viewport', (args) => ['status', 'doctor', 'who'].includes(args?.op)],
])

/** GitHub MCP read families. Any other `mcp__github__*` tool is treated as a write. */
const GITHUB_READ_PREFIXES = [
  'mcp__github__get_',
  'mcp__github__list_',
  'mcp__github__search_',
  'mcp__github__issue_read',
  'mcp__github__pull_request_read',
  'mcp__github__ui_get',
  'mcp__github__get_me',
  'mcp__github__run_secret_scanning',
]

function isReadOnlyCall(toolName, args) {
  if (READ_TOOLS.has(toolName)) return true
  const scoped = ARGUMENT_SCOPED.get(toolName)
  if (scoped !== undefined) {
    try {
      return scoped(args) === true
    } catch {
      return false
    }
  }
  for (const prefix of GITHUB_READ_PREFIXES) {
    if (toolName.startsWith(prefix)) return true
  }
  return false
}

function denyReason(toolName) {
  const label = toolName === '' ? '(unknown tool)' : toolName
  return (
    `[只读模式] 该会话已开启只读模式，工具 "${label}" 不在只读放行列表内，本次调用被拒绝。` +
    ` 如需执行写入或命令类操作，请让用户在输入框右侧关闭「只读」开关。` +
    ` Read-only mode is on for this session; "${label}" is not a read-only tool, so the call was denied.`
  )
}

function sessionIdOf(execution) {
  const session = execution?.agent?.session
  const id = session?.header?.id ?? session?.id
  return typeof id === 'string' ? id : undefined
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function ok(value) {
  return { ok: true, value }
}

function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

function createRegistry() {
  const armed = new Set()
  return {
    isArmed(sessionId) {
      return typeof sessionId === 'string' && armed.has(sessionId)
    },
    set(sessionId, active) {
      if (active) armed.add(sessionId)
      else armed.delete(sessionId)
      return armed.has(sessionId)
    },
    list() {
      return [...armed]
    },
  }
}

function handleRpc(registry, endpoint, payload) {
  const body = payload ?? {}
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''

  if (endpoint === 'list') return ok({ sessions: registry.list() })
  if (sessionId === '') return failure('bad-request', 'sessionId is required')

  if (endpoint === 'get') return ok({ sessionId, active: registry.isArmed(sessionId) })

  if (endpoint === 'set') {
    if (typeof body.active !== 'boolean') return failure('bad-request', 'active must be a boolean')
    return ok({ sessionId, active: registry.set(sessionId, body.active) })
  }

  return failure('not-found', `unknown endpoint "${String(endpoint)}"`)
}

function describe(active) {
  return active
    ? '只读模式：已开启（本会话仅放行读取类工具）。'
    : '只读模式：已关闭（本会话可正常写入）。'
}

function createCommand(registry) {
  return {
    name: 'readonly',
    description: '切换本会话的只读模式：/readonly on | off | toggle | status',
    input: { hint: 'on | off | toggle | status' },
    recordInput: false,
    handler(invocation) {
      const sessionId = sessionIdOf({ agent: invocation?.agent })
      if (sessionId === undefined) {
        return { kind: 'error', text: '只读模式：无法识别当前会话。' }
      }
      const word = String(invocation?.rawInput ?? '').trim().toLowerCase()
      const current = registry.isArmed(sessionId)

      if (word === '' || word === 'status') {
        return { kind: 'success', text: describe(current) }
      }
      if (['on', '1', 'true', '开', '开启'].includes(word)) {
        return { kind: 'success', text: describe(registry.set(sessionId, true)) }
      }
      if (['off', '0', 'false', '关', '关闭'].includes(word)) {
        return { kind: 'success', text: describe(registry.set(sessionId, false)) }
      }
      if (['toggle', '切换'].includes(word)) {
        return { kind: 'success', text: describe(registry.set(sessionId, !current)) }
      }
      return { kind: 'error', text: `只读模式：无法识别 "${word}"，可用 on / off / toggle / status。` }
    },
  }
}

export function apply(ctx) {
  const registry = createRegistry()

  // Enforcement: one guard for every tool call of every scope, reading live state.
  ctx.effect(
    () =>
      ctx.tools.guard((execution) => {
        const sessionId = sessionIdOf(execution)
        if (!registry.isArmed(sessionId)) return undefined
        const toolName = typeof execution?.name === 'string' ? execution.name : ''
        if (isReadOnlyCall(toolName, execution?.arguments)) return undefined
        return denyReason(toolName)
      }),
    'dsh-readonly-mode: tool guard',
  )

  // Client ⇄ Host channel used by the composer switch.
  ctx.inject(['connection'], (scope) => {
    try {
      const connection = scope.root?.connection
      if (connection === undefined || typeof connection.rpc?.handle !== 'function') return
      const dispose = connection.rpc.handle(CHANNEL, (endpoint, payload) => handleRpc(registry, endpoint, payload))
      scope.effect(() => dispose, 'dsh-readonly-mode: rpc channel')
      ctx.logger?.info?.(`[dsh-readonly-mode] rpc channel ${CHANNEL} ready`)
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-readonly-mode] RPC channel registration failed: ${errorMessage(error)}`)
    }
  })

  // Keyboard / headless fallback: /readonly on|off|toggle|status
  ctx.inject(['commands'], (scope) => {
    try {
      scope.effect(() => scope.commands.register(createCommand(registry)), 'dsh-readonly-mode: /readonly command')
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-readonly-mode] /readonly command registration failed: ${errorMessage(error)}`)
    }
  })
}
