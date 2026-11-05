/**
 * Read-only mode — Host half.
 *
 * The switch is per session and lives in memory (Set keyed by session id).
 * Enforcement is a plugin-wide `ctx.tools.guard()`: it runs for every tool call,
 * so flipping the switch takes effect on the very next call, and because a guard
 * has no "allow" result it cannot be overridden by listener ordering.
 *
 * Classification is fail-closed: only tools on the read allowlist below run while
 * the switch is on. Anything not proven to be a read is denied, which is the only
 * way to honour "不进行任何写入操作" without silently leaking new writer tools.
 *
 * The Client half reaches this state either through the package RPC channel below
 * or through the `/readonly` command; both paths write to the same registry.
 */

import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-readonly-mode'

export const inject = ['tools']

/** RPC channel shared with the Client half. */
export const CHANNEL = '/dsh-readonly-mode'

/** Local support log. Holds lifecycle events, RPC endpoint names and denials — no payloads. */
const LOG_PATH = join(tmpdir(), 'dsh-readonly-mode.log')
const LOG_LIMIT = 256 * 1024

const log = (line) => {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging must never break enforcement */
  }
}

const resetLog = () => {
  try {
    if (statSync(LOG_PATH).size > LOG_LIMIT) writeFileSync(LOG_PATH, '')
  } catch {
    /* first run */
  }
}

/**
 * Tools that only read. Everything outside this set (and the dictionary below) is
 * refused while read-only mode is on.
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

/**
 * Session id of one tool execution.
 *
 * `ToolExecution.agent` is optional and `Session.header.id` is the canonical id
 * (`Session.id` is a derived accessor), so the shapes are tried widest-first and
 * the first string wins.
 */
function sessionIdOf(execution) {
  const session = execution?.agent?.session ?? execution?.session
  const candidates = [session?.header?.id, session?.id, execution?.sessionId, execution?.agent?.id]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
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

  if (endpoint === 'ping') return ok({ channel: CHANNEL, sessions: registry.list() })
  if (endpoint === 'list') return ok({ sessions: registry.list() })
  if (sessionId === '') return failure('bad-request', 'sessionId is required')

  if (endpoint === 'get') return ok({ sessionId, active: registry.isArmed(sessionId) })

  if (endpoint === 'set') {
    if (typeof body.active !== 'boolean') return failure('bad-request', 'active must be a boolean')
    return ok({ sessionId, active: registry.set(sessionId, body.active) })
  }

  return failure('not-found', `unknown endpoint "${String(endpoint)}"`)
}

/**
 * Human text plus a machine-readable `readonly=on|off` token, so the Client half can
 * read the state back from a command result when the RPC channel is unavailable.
 */
function describe(active) {
  return active
    ? `只读模式：已开启（本会话仅放行读取类工具）。readonly=on`
    : `只读模式：已关闭（本会话可正常写入）。readonly=off`
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
        log(`command on ${sessionId}`)
        return { kind: 'success', text: describe(registry.set(sessionId, true)) }
      }
      if (['off', '0', 'false', '关', '关闭'].includes(word)) {
        log(`command off ${sessionId}`)
        return { kind: 'success', text: describe(registry.set(sessionId, false)) }
      }
      if (['toggle', '切换'].includes(word)) {
        log(`command toggle ${sessionId}`)
        return { kind: 'success', text: describe(registry.set(sessionId, !current)) }
      }
      return { kind: 'error', text: `只读模式：无法识别 "${word}"，可用 on / off / toggle / status。` }
    },
  }
}

/** The Connection service, whichever way this build exposes it to a plugin fiber. */
function connectionOf(scope) {
  try {
    const direct = scope.get('connection')
    if (direct !== undefined && direct !== null) return direct
  } catch {
    /* fall through */
  }
  try {
    if (scope.connection !== undefined) return scope.connection
  } catch {
    /* fall through */
  }
  try {
    if (scope.root?.connection !== undefined) return scope.root.connection
  } catch {
    /* fall through */
  }
  return undefined
}

export function apply(ctx) {
  const registry = createRegistry()
  resetLog()
  log(`apply (${process.version})`)

  // Enforcement: one guard for every tool call of every scope, reading live state.
  ctx.effect(
    () =>
      ctx.tools.guard((execution) => {
        const sessionId = sessionIdOf(execution)
        if (!registry.isArmed(sessionId)) return undefined
        const toolName = typeof execution?.name === 'string' ? execution.name : ''
        if (isReadOnlyCall(toolName, execution?.arguments)) return undefined
        log(`denied ${toolName}`)
        return denyReason(toolName)
      }),
    'dsh-readonly-mode: tool guard',
  )
  log('guard registered')

  // Client ⇄ Host channel used by the composer switch. `webServer` is requested
  // alongside `connection` because the channel is served as a web route: some
  // builds resolve `connection.rpc` lazily through that service.
  ctx.inject(['connection', 'webServer'], (scope) => {
    try {
      const connection = connectionOf(scope)
      if (connection === undefined) {
        log('channel: no connection service in this build')
        return
      }
      if (typeof connection.rpc?.handle !== 'function') {
        log('channel: connection.rpc.handle missing')
        return
      }
      const dispose = connection.rpc.handle(CHANNEL, (endpoint, payload) => {
        log(`rpc ${String(endpoint)}`)
        return handleRpc(registry, endpoint, payload)
      })
      scope.effect(() => dispose, 'dsh-readonly-mode: rpc channel')
      log(`channel registered ${CHANNEL}`)
    } catch (error) {
      log(`channel failed: ${errorMessage(error)}`)
      ctx.logger?.warn?.(`[dsh-readonly-mode] RPC channel registration failed: ${errorMessage(error)}`)
    }
  })

  // Keyboard / headless / Client fallback: /readonly on|off|toggle|status
  ctx.inject(['commands'], (scope) => {
    try {
      scope.effect(() => scope.commands.register(createCommand(registry)), 'dsh-readonly-mode: /readonly command')
      log('command registered')
    } catch (error) {
      log(`command failed: ${errorMessage(error)}`)
      ctx.logger?.warn?.(`[dsh-readonly-mode] /readonly command registration failed: ${errorMessage(error)}`)
    }
  })
}
