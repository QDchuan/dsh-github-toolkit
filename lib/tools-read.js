/**
 * Read-only GitHub tools: identity, repositories, files, search, issues, pull
 * requests, commits, branches, and CI checks.
 *
 * @module dsh-github-toolkit/tools-read
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { nextPageOf } from './rest.js'
import {
  clip,
  compactBranch,
  compactCheckRun,
  compactComment,
  compactCommit,
  compactIssue,
  compactPull,
  compactRepo,
  listValue,
  loginOf,
  renderJson,
  renderList,
  shortSha,
} from './format.js'
import { jsonOutput, pageParameter, pageQuery, perPageParameter, repoOf, repoParameters } from './shared.js'

/**
 * Build the read-only tool set.
 * @param {object} deps - Tool dependencies.
 * @param {ReturnType<import('./rest.js').createClient>} deps.client - GitHub client.
 * @param {object} deps.config - Plugin config.
 * @param {() => Promise<{token: string, source: string}>} deps.resolveCredential - Credential resolution.
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition[]} Tool definitions.
 */
export function createReadTools(deps) {
  const { client, config, resolveCredential } = deps
  const timeoutMs = config.timeoutMs

  return [
    // ── identity ─────────────────────────────────────────────────────────────
    defineTool({
      name: 'github_auth_status',
      description: '检查当前 GitHub 令牌的身份、权限范围（scopes）与剩余速率额度。任何 GitHub 调用报 401/403/404 时先调用它诊断凭证问题。',
      parameters: {},
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        const credential = await resolveCredential()
        const [user, rate] = await Promise.all([
          client.request('GET', '/user', { signal: exec.signal }),
          client.request('GET', '/rate_limit', { signal: exec.signal }),
        ])
        const scopes = user.headers.get('x-oauth-scopes')
        const core = rate.data?.resources?.core
        return {
          login: user.data?.login,
          name: user.data?.name ?? undefined,
          type: user.data?.type,
          scopes: scopes === null || scopes === '' ? '（令牌未报告 scopes：细粒度 PAT 通常不返回该响应头）' : scopes,
          credentialSource: credential.source,
          credentialRef: config.tokenRef,
          rateLimit: core === undefined ? undefined : {
            limit: core.limit,
            remaining: core.remaining,
            reset: typeof core.reset === 'number' ? new Date(core.reset * 1000).toISOString() : undefined,
          },
        }
      },
    }),

    // ── repositories and files ───────────────────────────────────────────────
    defineTool({
      name: 'github_get_repository',
      description: '获取一个 GitHub 仓库的元信息（默认分支、语言、star、开放 issue 数、可见性等）。',
      parameters: { ...repoParameters() },
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { owner, repo } = repoOf(args, config)
        const { data } = await client.request('GET', `/repos/${owner}/${repo}`, { signal: exec.signal })
        return compactRepo(data)
      },
    }),

    defineTool({
      name: 'github_read_file',
      description: '读取仓库中一个文件的内容（可指定分支/tag/commit），或列出一个目录的条目。文本文件按 UTF-8 解码；过大的文件只返回元信息。',
      parameters: {
        ...repoParameters(),
        path: { type: 'string', required: true, description: '仓库内的路径，例如 src/index.ts 或 packages' },
        ref: { type: 'string', description: '分支名、tag 或 commit SHA；省略时用仓库默认分支' },
      },
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { owner, repo } = repoOf(args, config)
        const { data } = await client.request('GET', `/repos/${owner}/${repo}/contents/${encodePath(args.path)}`, {
          query: { ref: args.ref },
          signal: exec.signal,
        })
        if (Array.isArray(data)) {
          return {
            kind: 'directory',
            path: args.path,
            ref: args.ref ?? undefined,
            items: data.map((entry) => ({
              name: entry.name,
              path: entry.path,
              type: entry.type,
              size: entry.size,
              sha: entry.sha,
            })),
          }
        }
        const encoded = typeof data?.content === 'string' ? data.content.replace(/\s+/g, '') : ''
        const size = typeof data?.size === 'number' ? data.size : undefined
        const base = {
          kind: 'file',
          path: data?.path ?? args.path,
          ref: args.ref ?? undefined,
          sha: data?.sha,
          size,
          url: data?.html_url,
        }
        if (encoded === '') {
          return { ...base, note: '文件为空，或该条目不是可下载的文件。' }
        }
        if (size !== undefined && size > config.maxFileBytes) {
          return {
            ...base,
            truncated: true,
            note: `文件 ${size} 字节超过 maxFileBytes=${config.maxFileBytes}，未返回内容。可调大配置，或用 github_api 取原始内容。`,
          }
        }
        const text = Buffer.from(encoded, 'base64').toString('utf8')
        if (text.includes('\u0000')) {
          return { ...base, binary: true, note: '二进制文件，未返回内容。' }
        }
        return {
          ...base,
          truncated: text.length > config.maxTextChars ? true : undefined,
          content: clip(text, config.maxTextChars),
        }
      },
    }),

    // ── search ───────────────────────────────────────────────────────────────
    defineTool({
      name: 'github_search',
      description: '用 GitHub 搜索 API 搜索仓库、代码、issue/PR、commit 或用户。代码搜索支持限定词，例如 repo:owner/name path:src language:ts keyword。',
      parameters: {
        kind: {
          type: 'string',
          required: true,
          enum: ['repositories', 'code', 'issues', 'commits', 'users'],
          description: '搜索类型',
        },
        q: {
          type: 'string',
          required: true,
          description: '搜索查询，支持 GitHub 限定词；空格与特殊字符会被正确编码',
        },
        sort: {
          type: 'string',
          description: '排序字段：repositories 支持 stars/forks/updated；issues 支持 created/updated/comments；仅这两类与 commits 支持排序',
        },
        order: { type: 'string', enum: ['asc', 'desc'], description: '排序方向' },
        perPage: perPageParameter(config),
        page: pageParameter(),
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => renderList(value, (item) => searchLine(args.kind, item)),
      },
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const supportsSort = args.kind === 'repositories' || args.kind === 'issues' || args.kind === 'commits'
        const { data } = await client.request('GET', `/search/${args.kind}`, {
          query: pageQuery(args, config, {
            q: args.q,
            ...(supportsSort ? { sort: args.sort, order: args.order } : {}),
          }),
          signal: exec.signal,
        })
        const items = Array.isArray(data?.items) ? data.items : []
        const value = listValue(
          `搜索 ${args.kind}「${args.q}」`,
          items.map((item) => projectSearchItem(args.kind, item, config)),
          { totalCount: data?.total_count },
        )
        if (data?.incomplete_results === true) value.incompleteResults = true
        return value
      },
    }),

    // ── issues ───────────────────────────────────────────────────────────────
    defineTool({
      name: 'github_list_issues',
      description: '列出仓库的 issue，可按状态、标签、负责人、创建者过滤。只返回 issue（PR 请用 github_list_pull_requests）。',
      parameters: {
        ...repoParameters(),
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: '状态，默认 open' },
        labels: { type: 'string', description: '逗号分隔的标签名，例如 bug,help wanted' },
        assignee: { type: 'string', description: '负责人 login；none 表示未分配，* 表示任意' },
        creator: { type: 'string', description: '创建者 login' },
        since: { type: 'string', description: 'ISO 8601 时间，只返回此后更新的 issue' },
        sort: { type: 'string', enum: ['created', 'updated', 'comments'], description: '排序字段' },
        direction: { type: 'string', enum: ['asc', 'desc'], description: '排序方向' },
        perPage: perPageParameter(config),
        page: pageParameter(),
      },
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { owner, repo } = repoOf(args, config)
        const { data, nextUrl } = await client.request('GET', `/repos/${owner}/${repo}/issues`, {
          query: pageQuery(args, config, {
            state: args.state ?? 'open',
            labels: args.labels,
            assignee: args.assignee,
            creator: args.creator,
            since: args.since,
            sort: args.sort,
            direction: args.direction,
          }),
          signal: exec.signal,
        })
        return listValue(
          `${owner}/${repo} issues（state=${args.state ?? 'open'}）`,
          (Array.isArray(data) ? data : []).map((issue) => compactIssue(issue, config.maxTextChars)),
          { nextPage: nextPageOf(nextUrl) },
        )
      },
    }),

    defineTool({
      name: 'github_get_issue',
      description: '按编号获取单个 issue 或 PR 的详情（正文、标签、负责人、评论数）；可选返回评论列表。',
      parameters: {
        ...repoParameters(),
        number: { type: 'integer', required: true, description: 'issue 或 PR 编号' },
        includeComments: { type: 'boolean', description: '是否同时返回评论列表，默认 false' },
      },
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { owner, repo } = repoOf(args, config)
        const { data } = await client.request('GET', `/repos/${owner}/${repo}/issues/${args.number}`, { signal: exec.signal })
        const issue = compactIssue(data, config.maxTextChars)
        if (args.includeComments !== true) return issue
        const comments = await client.request('GET', `/repos/${owner}/${repo}/issues/${args.number}/comments`, {
          query: { per_page: 100 },
          signal: exec.signal,
        })
        return {
          ...issue,
          commentList: (Array.isArray(comments.data) ? comments.data : [])
            .map((comment) => compactComment(comment, config.maxTextChars)),
        }
      },
    }),

    // ── pull requests ────────────────────────────────────────────────────────
    defineTool({
      name: 'github_list_pull_requests',
      description: '列出仓库的 PR，可按状态、head/base 分支、排序筛选。用于查看待审 PR 或某分支上的 PR。',
      parameters: {
        ...repoParameters(),
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: '状态，默认 open' },
        head: { type: 'string', description: '筛选 head 分支，格式 owner:branch 或 branch' },
        base: { type: 'string', description: '筛选 base 分支名' },
        sort: { type: 'string', enum: ['created', 'updated', 'popularity', 'long-running'], description: '排序字段' },
        direction: { type: 'string', enum: ['asc', 'desc'], description: '排序方向' },
        perPage: perPageParameter(config),
        page: pageParameter(),
      },
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { owner, repo } = repoOf(args, config)
        const { data, nextUrl } = await client.request('GET', `/repos/${owner}/${repo}/pulls`, {
          query: pageQuery(args, config, {
            state: args.state ?? 'open',
            head: args.head,
            base: args.base,
            sort: args.sort,
            direction: args.direction,
          }),
          signal: exec.signal,
        })
        return listValue(
          `${owner}/${repo} PR（state=${args.state ?? 'open'}）`,
          (Array.isArray(data) ? data : []).map((pull) => compactPull(pull, config.maxTextChars)),
          { nextPage: nextPageOf(nextUrl) },
        )
      },
    }),

    defineTool({
      name: 'github_get_pull_request',
      description: '按编号获取单个 PR 的详情；可选返回变更文件列表（含 patch）与完整 diff 文本。评审 PR 时用这个工具。',
      parameters: {
        ...repoParameters(),
        number: { type: 'integer', required: true, description: 'PR 编号' },
        includeFiles: { type: 'boolean', description: '是否返回变更文件列表，默认 true' },
        includeDiff: { type: 'boolean', description: '是否返回完整 unified diff 文本，默认 false' },
      },
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { owner, repo } = repoOf(args, config)
        const { data } = await client.request('GET', `/repos/${owner}/${repo}/pulls/${args.number}`, { signal: exec.signal })
        const pull = compactPull(data, config.maxTextChars)
        /** @type {Record<string, unknown>} */
        const extra = {}
        if (args.includeFiles !== false) {
          const files = await client.request('GET', `/repos/${owner}/${repo}/pulls/${args.number}/files`, {
            query: { per_page: 100 },
            signal: exec.signal,
          })
          const list = Array.isArray(files.data) ? files.data : []
          extra.files = list.map((file) => ({
            path: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch: clip(file.patch, config.maxPatchChars),
          }))
          if (files.nextUrl !== undefined) extra.filesNote = '变更文件超过 100 个，仅返回前 100 个。'
        }
        if (args.includeDiff === true) {
          const diff = await client.request('GET', `/repos/${owner}/${repo}/pulls/${args.number}`, {
            accept: 'application/vnd.github.v3.diff',
            asText: true,
            signal: exec.signal,
          })
          extra.diff = clip(diff.data, config.maxDiffChars)
        }
        return { ...pull, ...extra }
      },
    }),

    // ── history and CI ───────────────────────────────────────────────────────
    defineTool({
      name: 'github_list_commits',
      description: '列出仓库的 commit，可按分支/SHA、文件路径、作者筛选。',
      parameters: {
        ...repoParameters(),
        sha: { type: 'string', description: '分支名、tag 或 commit SHA，默认仓库默认分支' },
        path: { type: 'string', description: '只返回改动该路径的 commit' },
        author: { type: 'string', description: 'GitHub login 或邮箱' },
        perPage: perPageParameter(config),
        page: pageParameter(),
      },
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { owner, repo } = repoOf(args, config)
        const { data, nextUrl } = await client.request('GET', `/repos/${owner}/${repo}/commits`, {
          query: pageQuery(args, config, { sha: args.sha, path: args.path, author: args.author }),
          signal: exec.signal,
        })
        return listValue(
          `${owner}/${repo} commits${args.path === undefined ? '' : `（path=${args.path}）`}`,
          (Array.isArray(data) ? data : []).map((commit) => compactCommit(commit, config.maxTextChars)),
          { nextPage: nextPageOf(nextUrl) },
        )
      },
    }),

    defineTool({
      name: 'github_list_branches',
      description: '列出仓库的分支（名称、是否受保护、最新 commit）。',
      parameters: {
        ...repoParameters(),
        perPage: perPageParameter(config),
        page: pageParameter(),
      },
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { owner, repo } = repoOf(args, config)
        const { data, nextUrl } = await client.request('GET', `/repos/${owner}/${repo}/branches`, {
          query: pageQuery(args, config),
          signal: exec.signal,
        })
        return listValue(
          `${owner}/${repo} 分支`,
          (Array.isArray(data) ? data : []).map(compactBranch),
          { nextPage: nextPageOf(nextUrl) },
        )
      },
    }),

    defineTool({
      name: 'github_get_checks',
      description: '获取某个 ref（分支/tag/commit SHA）的 CI 状态：提交状态 + 所有 check run 的名称、状态与结论。用于确认 PR 的 CI 是否通过。',
      parameters: {
        ...repoParameters(),
        ref: { type: 'string', required: true, description: '分支名、tag 或 commit SHA（PR 可用 head SHA）' },
      },
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { owner, repo } = repoOf(args, config)
        const ref = encodeURIComponent(args.ref)
        const [combined, runs] = await Promise.all([
          client.request('GET', `/repos/${owner}/${repo}/commits/${ref}/status`, { signal: exec.signal }),
          client.request('GET', `/repos/${owner}/${repo}/commits/${ref}/check-runs`, {
            query: { per_page: 100 },
            signal: exec.signal,
          }),
        ])
        return {
          ref: args.ref,
          combinedState: combined.data?.state,
          statuses: (Array.isArray(combined.data?.statuses) ? combined.data.statuses : []).map((status) => ({
            context: status.context,
            state: status.state,
            description: clip(status.description, 200),
            targetUrl: status.target_url ?? undefined,
          })),
          checkRuns: (Array.isArray(runs.data?.check_runs) ? runs.data.check_runs : []).map(compactCheckRun),
        }
      },
    }),
  ]
}

/**
 * Percent-encode each path segment while keeping separators.
 * @param {string} path - Repository-relative path.
 * @returns {string} Encoded path.
 */
function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/')
}

/**
 * Map a raw search item into a compact canonical object.
 * @param {string} kind - Search kind.
 * @param {any} item - Raw search item.
 * @param {object} config - Plugin config.
 * @returns {Record<string, unknown>} Curated item.
 */
function projectSearchItem(kind, item, config) {
  switch (kind) {
    case 'repositories':
      return compactRepo(item)
    case 'code':
      return {
        path: item.path,
        repository: item.repository?.full_name,
        sha: shortSha(item.sha),
        url: item.html_url,
      }
    case 'issues':
      return compactIssue(item, config.maxTextChars)
    case 'commits':
      return { ...compactCommit(item, config.maxTextChars), repository: item.repository?.full_name }
    case 'users':
      return { login: loginOf(item), type: item.type, url: item.html_url }
    default:
      return { value: item }
  }
}

/**
 * One render line for a curated search item.
 * @param {string} kind - Search kind.
 * @param {any} item - Curated item.
 * @returns {string} One-line summary.
 */
function searchLine(kind, item) {
  switch (kind) {
    case 'repositories':
      return `${item.fullName} ★${item.stars ?? 0}${item.language === undefined ? '' : ` ${item.language}`} — ${item.description ?? '(无描述)'} — ${item.url}`
    case 'code':
      return `${item.repository} ${item.path} @${item.sha} — ${item.url}`
    case 'issues':
      return `#${item.number} [${item.state}] ${item.title}${item.isPullRequest === true ? '（PR）' : ''} — ${item.url}`
    case 'commits':
      return `${item.repository ?? ''} ${item.sha} ${item.message ?? ''} — ${item.url ?? ''}`
    case 'users':
      return `${item.login} (${item.type}) — ${item.url}`
    default:
      return JSON.stringify(item).slice(0, 200)
  }
}
