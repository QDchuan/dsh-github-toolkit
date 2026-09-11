/**
 * Minimal, dependency-free GitHub REST client for `dsh-github-toolkit`.
 *
 * Design notes:
 * - The token is resolved per request through a caller-supplied `resolveToken`,
 *   so rotating the PAT in the DSH credential store applies to the next call
 *   without a reload.
 * - `apiBase`, `timeoutMs`, and `userAgent` are read from the live options
 *   object on every request, so a saved settings change applies immediately.
 * - Every failure becomes an error whose message states what the model should
 *   do next (rotate the PAT, wait for the rate limit, request a wider scope),
 *   never a bare status code.
 * - Bodies are read as text and only then parsed, so a non-JSON error page is
 *   still reportable.
 *
 * @module dsh-github-toolkit/rest
 */

/** No usable GitHub credential is configured. */
export class GitHubAuthError extends Error {
  /**
   * @param {string} message - Model-facing instruction.
   * @param {{hint?: string}} [info] - Optional remediation hint.
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'GitHubAuthError'
    if (info.hint !== undefined) this.hint = info.hint
  }
}

/** One failed GitHub REST call. */
export class GitHubApiError extends Error {
  /**
   * @param {string} message - Model-facing description of the failure.
   * @param {object} info - Structured context for the model.
   * @param {number} [info.status] - HTTP status, absent for transport failures.
   * @param {string} info.method - HTTP method that failed.
   * @param {string} info.url - Full request URL.
   * @param {string} [info.detail] - GitHub's own `message`/error text.
   * @param {string} [info.hint] - What to try next.
   * @param {object} [info.rateLimit] - `{ limit, remaining, reset }` when known.
   */
  constructor(message, info) {
    super(message)
    this.name = 'GitHubApiError'
    Object.assign(this, info)
  }
}

/**
 * Extract the `rel="next"` URL from a GitHub `Link` header.
 * @param {string | null} linkHeader - Raw `Link` header value.
 * @returns {string | undefined} The next-page URL, when GitHub supplied one.
 */
export function parseNextLink(linkHeader) {
  if (typeof linkHeader !== 'string' || linkHeader === '') return undefined
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim())
    if (match !== null && match[2] === 'next') return match[1]
  }
  return undefined
}

/**
 * Render a `Link` header's next target as a page number when it points at the
 * same API base, so list tools can report a plain `nextPage`.
 * @param {string | undefined} nextUrl - Next-page URL from {@link parseNextLink}.
 * @returns {number | undefined} The `page` query value, when parseable.
 */
export function nextPageOf(nextUrl) {
  if (nextUrl === undefined) return undefined
  try {
    const page = new URL(nextUrl).searchParams.get('page')
    return page === null ? undefined : Number(page)
  } catch {
    return undefined
  }
}

/**
 * Read GitHub's rate-limit headers into a plain object.
 * @param {Headers} headers - Response headers.
 * @returns {{limit?: number, remaining?: number, reset?: string} | undefined}
 */
function readRateLimit(headers) {
  const limit = headers.get('x-ratelimit-limit')
  const remaining = headers.get('x-ratelimit-remaining')
  const reset = headers.get('x-ratelimit-reset')
  if (limit === null && remaining === null && reset === null) return undefined
  /** @type {{limit?: number, remaining?: number, reset?: string}} */
  const rate = {}
  if (limit !== null) rate.limit = Number(limit)
  if (remaining !== null) rate.remaining = Number(remaining)
  if (reset !== null) {
    const seconds = Number(reset)
    rate.reset = Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : reset
  }
  return rate
}

/**
 * Build the message for one failed response.
 * @param {number} status - HTTP status.
 * @param {Response} response - The failed response.
 * @param {string} method - Request method.
 * @param {string} url - Full request URL.
 * @param {unknown} payload - Parsed JSON payload, when the body was JSON.
 * @param {string} rawText - Raw body text (bounded by the caller).
 * @param {string} credentialLabel - Credential reference shown in remediation text.
 * @returns {GitHubApiError} The error to throw.
 */
function failureFor(status, response, method, url, payload, rawText, credentialLabel) {
  const detail = typeof payload === 'object' && payload !== null && typeof payload.message === 'string'
    ? payload.message
    : rawText.slice(0, 300)
  const rateLimit = readRateLimit(response.headers)
  /** @type {string} */
  let message
  /** @type {string | undefined} */
  let hint
  const isRateLimited = rateLimit?.remaining === 0

  switch (true) {
    case status === 401:
      message = `GitHub 认证失败（401）：令牌无效、已过期或已被撤销。`
      hint = `请更新 DSH 凭证中的 ${credentialLabel}，然后重试。`
      break
    case status === 403 && isRateLimited:
      message = `GitHub API 速率受限（403）：剩余额度 0${rateLimit?.reset === undefined ? '' : `，将于 ${rateLimit.reset} 重置`}。`
      hint = '等待重置后重试，或换用额度更高的令牌（GitHub App / 更高的 PAT 限额）。'
      break
    case status === 403:
      message = `GitHub 拒绝访问（403）：${detail ?? '权限不足'}`
      hint = '常见原因：令牌缺少所需 scope（repo / read:org / workflow），或组织启用了 SAML SSO 且令牌未授权。'
      break
    case status === 404:
      message = `GitHub 返回 404：${detail ?? '资源不存在'}`
      hint = '仓库/issue/分支可能不存在，或当前令牌无权访问私有资源（私有仓库需要 repo scope）。'
      break
    case status === 409:
      message = `GitHub 返回 409（冲突）：${detail ?? '请求与仓库当前状态冲突'}`
      hint = '空仓库无法创建 PR；请先提交一个初始 commit。'
      break
    case status === 422:
      message = `GitHub 拒绝了请求（422）：${detail ?? '参数校验失败'}`
      hint = '检查参数：分支是否存在、head/base 是否同名、标签/负责人是否为仓库协作者。'
      break
    case status === 429:
      message = `GitHub 触发了次级速率限制（429）：请求过于频繁。`
      hint = response.headers.get('retry-after') === null
        ? '降低调用频率后重试。'
        : `请在 ${response.headers.get('retry-after')} 秒后重试。`
      break
    case status >= 500:
      message = `GitHub 服务端错误（${status}）：${detail ?? '上游故障'}`
      hint = '稍后重试。'
      break
    default:
      message = `GitHub 请求失败（${status}）：${detail ?? '未知错误'}`
      break
  }

  const errors = typeof payload === 'object' && payload !== null && Array.isArray(payload.errors)
    ? payload.errors.map((entry) => entry?.message ?? JSON.stringify(entry)).join('; ')
    : undefined
  return new GitHubApiError(message, {
    status,
    method,
    url,
    detail: errors === undefined ? detail : `${detail}（${errors}）`,
    hint,
    rateLimit,
  })
}

/**
 * Create a GitHub REST client.
 * @param {object} options - Client options.
 * @param {string} options.apiBase - REST base, e.g. `https://api.github.com` (no trailing slash).
 * @param {string} options.userAgent - `User-Agent` sent with every request.
 * @param {number} options.timeoutMs - Per-request timeout budget.
 * @param {string} options.credentialLabel - Credential reference named in error text.
 * @param {() => Promise<string>} options.resolveToken - Per-request token resolution.
 * @returns {{request: (method: string, path: string, options?: object) => Promise<{status: number, data: any, headers: Headers, nextUrl?: string}>}}
 */
export function createClient(options) {
  const { credentialLabel, resolveToken } = options

  /**
   * Perform one REST call.
   * @param {string} method - HTTP method.
   * @param {string} path - API path beginning with `/`.
   * @param {object} [init] - Request options.
   * @param {Record<string, unknown>} [init.query] - Query parameters; empty values are dropped.
   * @param {unknown} [init.body] - JSON body.
   * @param {AbortSignal} [init.signal] - Caller cancellation signal.
   * @param {string} [init.accept] - `Accept` override (raw file content, diffs).
   * @param {boolean} [init.asText] - Return the body as text instead of parsed JSON.
   * @returns {Promise<{status: number, data: any, headers: Headers, nextUrl?: string}>}
   */
  async function request(method, path, init = {}) {
    const token = await resolveToken()
    const timeoutMs = options.timeoutMs
    const userAgent = options.userAgent
    const base = String(options.apiBase).replace(/\/+$/, '')
    const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`)
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }

    /** @type {Record<string, string>} */
    const headers = {
      accept: init.accept ?? 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': userAgent,
      'x-github-api-version': '2022-11-28',
    }
    if (init.body !== undefined) headers['content-type'] = 'application/json'

    const budget = new AbortController()
    const timer = setTimeout(() => budget.abort(new Error('timeout')), timeoutMs)
    const signal = init.signal === undefined
      ? budget.signal
      : AbortSignal.any([init.signal, budget.signal])

    /** @type {Response} */
    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        signal,
        redirect: 'follow',
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
    } catch (error) {
      if (init.signal?.aborted === true) throw error
      if (budget.signal.aborted) {
        throw new GitHubApiError(
          `GitHub 请求超时（${timeoutMs} ms）：${method} ${url.pathname}。`,
          { method, url: url.href, hint: '重试，或在插件配置里调大 timeoutMs。' },
        )
      }
      throw new GitHubApiError(
        `无法连接 GitHub：${error instanceof Error ? error.message : String(error)}`,
        { method, url: url.href, hint: '检查网络、代理（HTTPS_PROXY）或 apiBase 配置。' },
      )
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    let payload
    if (init.asText !== true && text !== '') {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = undefined
      }
    }

    if (!response.ok) {
      throw failureFor(response.status, response, method, url.href, payload, text, credentialLabel)
    }

    const nextUrl = parseNextLink(response.headers.get('link'))
    return {
      status: response.status,
      data: init.asText === true ? text : (payload ?? null),
      headers: response.headers,
      ...(nextUrl === undefined ? {} : { nextUrl }),
    }
  }

  return { request }
}
