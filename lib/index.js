/**
 * `dsh-github-toolkit` — GitHub REST access for the harness, exposed as native
 * `github_*` tools plus a Web settings section (see `./client.js`).
 *
 * This is the package root and the module a profile row mounts, by package name
 * or by path.
 *
 * Three seams keep the browser page and the model in sync:
 * - the PAT lives in the DSH credential store by reference (default
 *   `GITHUB_TOKEN`) and is resolved per request, so rotating it applies to the
 *   next call and no secret ever reaches `cordis.patch.yml`;
 * - the plugin registers the `tool-github` settings namespace, so the settings
 *   section writes ordinary settings fields and this plugin observes them;
 * - every tool reads one live config object, and the tool set is re-registered
 *   when a save changes it (a write-mode switch takes effect immediately).
 *
 * @module dsh-github-toolkit
 */

import z from '@deepseek-ai/schemastery'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { GitHubAuthError, createClient } from './rest.js'
import { createReadTools } from './tools-read.js'
import { createApiTool, createWriteTools } from './tools-write.js'

/** Stable loader identity. */
export const name = 'tool-github'

/** Services this plugin needs to register tools and read credentials. */
export const inject = ['tools', 'credentials']

/** Settings namespace carrying every user-editable option. */
export const SETTINGS_NAMESPACE = 'tool-github'

/** Credential reference used when the settings section names none. */
export const DEFAULT_TOKEN_REF = 'GITHUB_TOKEN'

/**
 * Plugin configuration — the composition defaults for the settings namespace.
 *
 * A user override lives in `settings.yaml` and is written by the Web settings
 * section; the plugin never needs a restart to pick one up.
 */
export const Config = z.object({
  tokenRef: z.string().default(DEFAULT_TOKEN_REF),
  apiBase: z.string().default('https://api.github.com'),
  defaultOwner: z.string(),
  defaultRepo: z.string(),
  timeoutMs: z.number().default(30000),
  perPage: z.number().default(30),
  maxTextChars: z.number().default(6000),
  maxPatchChars: z.number().default(3000),
  maxDiffChars: z.number().default(20000),
  maxFileBytes: z.number().default(400000),
  enableWrite: z.boolean().default(true),
  userAgent: z.string().default('dsh-github-toolkit/0.1.0'),
})

/** Positive-integer config keys validated at load time and at every save. */
const POSITIVE_INT_KEYS = [
  'timeoutMs',
  'perPage',
  'maxTextChars',
  'maxPatchChars',
  'maxDiffChars',
  'maxFileBytes',
]

/**
 * Reject a configuration the tools cannot act on.
 * @param {object} config - Composition or settings-resolved config.
 * @throws {Error} When a field is unusable.
 */
function assertUsable(config) {
  for (const key of POSITIVE_INT_KEYS) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) {
      throw new Error(`dsh-github-toolkit: ${key} 必须是正整数，当前为 ${config[key]}`)
    }
  }
  if (config.perPage > 100) throw new Error('dsh-github-toolkit: perPage 不能大于 100')
  if (typeof config.apiBase !== 'string' || config.apiBase.trim() === '') {
    throw new Error('dsh-github-toolkit: apiBase 不能为空')
  }
  if (!isCredentialRefName(config.tokenRef)) {
    throw new Error(`dsh-github-toolkit: tokenRef「${config.tokenRef}」不是合法的凭证名（需为 POSIX shell 标识符，例如 GITHUB_TOKEN）`)
  }
}

/**
 * Register the GitHub tool set and the settings namespace.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Agent-scoped services.
 * @param {ReturnType<typeof Config>} config - Composition config.
 * @returns {void}
 */
export function apply(ctx, config) {
  assertUsable(config)

  /**
   * The one object every tool reads. It starts as the composition config and is
   * overwritten in place whenever the settings section commits a change, so a
   * registered tool never holds a stale snapshot.
   */
  const live = { ...config }

  /** Thunk returning the currently authoritative section (settings or composition). */
  let authoritative = () => config

  /**
   * Resolve the PAT, reporting which layer supplied it.
   * @returns {Promise<{token: string, source: string}>} The token and its origin.
   * @throws {GitHubAuthError} When no layer has a value.
   */
  async function resolveCredential() {
    const refName = live.tokenRef
    try {
      const hit = await ctx.credentials.resolve(credentialRef(refName))
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.trim() !== '') {
        return { token: hit.value.trim(), source: `DSH 凭证 ${refName}（${hit.source}）` }
      }
    } catch (error) {
      // A credential store that is unavailable must not hide the env fallback.
      ctx.logger?.warn?.(`dsh-github-toolkit: 读取凭证失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const ambient = process.env[refName]
    if (typeof ambient === 'string' && ambient.trim() !== '') {
      return { token: ambient.trim(), source: `进程环境变量 ${refName}` }
    }
    throw new GitHubAuthError(
      `未找到 GitHub 令牌：凭证 ${refName} 在 DSH 凭证库、.env 与进程环境中都为空。`,
      { hint: `在 Web 界面「设置 → GitHub」里粘贴 PAT 并保存，即可写入凭证 ${refName}。` },
    )
  }

  const client = createClient({
    // Read from `live` on every request, so settings changes apply immediately.
    get apiBase() { return live.apiBase },
    get timeoutMs() { return live.timeoutMs },
    get userAgent() { return live.userAgent },
    credentialLabel: live.tokenRef,
    resolveToken: async () => (await resolveCredential()).token,
  })

  const deps = { client, config: live, resolveCredential }

  /** Disposers for the currently registered tools. */
  let registered = []

  /**
   * Make a tool body's value lossless JSON.
   *
   * A canonical tool value is materialized as JSON, so an `undefined` property
   * — the natural shape of "this field was absent upstream" — makes the whole
   * result invalid instead of merely absent. One JSON round trip normalizes
   * every tool at once, and `undefined` itself becomes `null`.
   * @param {unknown} value - Value returned by a tool body.
   * @returns {unknown} A value that survives a JSON round trip.
   */
  function jsonSafe(value) {
    return value === undefined ? null : JSON.parse(JSON.stringify(value))
  }

  /**
   * Wrap one tool definition so its canonical value is lossless JSON.
   * @param {object} tool - Tool definition built by a factory.
   * @returns {object} The same definition with a normalizing body.
   */
  function lossless(tool) {
    const execute = tool.execute
    return {
      ...tool,
      async execute(args, exec) {
        return jsonSafe(await execute(args, exec))
      },
    }
  }

  /**
   * (Re)register the tool set for the current live config: a write-mode switch
   * adds or removes the mutating tools, and `github_api` re-narrows its method
   * enum, without a reload.
   */
  function syncTools() {
    for (const dispose of registered) dispose()
    registered = [
      ...createReadTools(deps),
      createApiTool(deps),
      ...(live.enableWrite === true ? createWriteTools(deps) : []),
    ].map((tool) => ctx.tools.register(lossless(tool)))
  }

  syncTools()

  // The settings section is optional: a composition without the settings
  // service (a headless run, for instance) keeps the composition config only.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
      setSource: (current) => {
        authoritative = current
      },
      onChange: () => {
        const next = { ...authoritative() }
        try {
          assertUsable(next)
        } catch (error) {
          ctx.logger?.warn?.(`dsh-github-toolkit: 忽略无效设置：${error instanceof Error ? error.message : String(error)}`)
          return
        }
        Object.assign(live, next)
        syncTools()
        ctx.logger?.info?.(`dsh-github-toolkit: 配置已更新（${live.enableWrite === true ? '可写' : '只读'}，工具 ${registered.length} 个）`)
      },
    })
  })
}
