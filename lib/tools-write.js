/**
 * Mutating GitHub tools: issues, comments, pull requests, file commits, and PR
 * reviews.
 *
 * These register only when the plugin config keeps `enableWrite` on.
 *
 * @module dsh-github-toolkit/tools-write
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { clip, compactIssue, compactPull, renderJson } from './format.js'
import { jsonOutput, repoOf, repoParameters } from './shared.js'

/**
 * Build the mutating tool set.
 * @param {object} deps - Tool dependencies.
 * @param {ReturnType<import('./rest.js').createClient>} deps.client - GitHub client.
 * @param {object} deps.config - Plugin config.
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition[]} Tool definitions.
 */
export function createWriteTools(deps) {
  const { client, config } = deps
  const timeoutMs = config.timeoutMs

  return [
    // ── issues ───────────────────────────────────────────────────────────────
    defineTool({
      name: 'github_create_issue',
      description: '在仓库中创建 issue。创建前先用 github_search / github_list_issues 确认没有重复 issue。',
      parameters: {
        ...repoParameters(),
        title: { type: 'string', required: true, description: 'issue 标题' },
        body: { type: 'string', description: 'Markdown 正文' },
        labels: { type: 'array', items: { type: 'string' }, description: '标签名数组（标签必须已存在于仓库）' },
        assignees: { type: 'array', items: { type: 'string' }, description: '负责人 login 数组（必须是仓库协作者）' },
        milestone: { type: 'integer', description: '里程碑编号' },
      },
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const { owner, repo } = repoOf(args, config)
        const { data } = await client.request('POST', `/repos/${owner}/${repo}/issues`, {
          body: {
            title: args.title,
            ...(args.body === undefined ? {} : { body: args.body }),
            ...(args.labels === undefined ? {} : { labels: args.labels }),
            ...(args.assignees === undefined ? {} : { assignees: args.assignees }),
            ...(args.milestone === undefined ? {} : { milestone: args.milestone }),
          },
          signal: exec.signal,
        })
        return compactIssue(data, config.maxTextChars)
      },
    }),

    defineTool({
      name: 'github_comment',
      description: '在 issue 或 PR 下发表评论（两者共用编号空间）。',
      parameters: {
        ...repoParameters(),
        number: { type: 'integer', required: true, description: 'issue 或 PR 编号' },
        body: { type: 'string', required: true, description: 'Markdown 评论正文' },
      },
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const { owner, repo } = repoOf(args, config)
        const { data } = await client.request('POST', `/repos/${owner}/${repo}/issues/${args.number}/comments`, {
          body: { body: args.body },
          signal: exec.signal,
        })
        return { id: data?.id, url: data?.html_url, createdAt: data?.created_at }
      },
    }),

    defineTool({
      name: 'github_update_issue',
      description: '修改 issue 或 PR 的标题、正文、状态（关闭/重新打开）、标签或负责人。只传需要修改的字段。',
      parameters: {
        ...repoParameters(),
        number: { type: 'integer', required: true, description: 'issue 或 PR 编号' },
        state: { type: 'string', enum: ['open', 'closed'], description: '目标状态' },
        stateReason: { type: 'string', enum: ['completed', 'not_planned', 'reopened'], description: '关闭原因（GitHub 新字段）' },
        title: { type: 'string', description: '新标题' },
        body: { type: 'string', description: '新正文（整体替换）' },
        labels: { type: 'array', items: { type: 'string' }, description: '标签名数组（整体替换）' },
        assignees: { type: 'array', items: { type: 'string' }, description: '负责人 login 数组（整体替换）' },
      },
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const { owner, repo } = repoOf(args, config)
        /** @type {Record<string, unknown>} */
        const body = {}
        if (args.state !== undefined) body.state = args.state
        if (args.stateReason !== undefined) body.state_reason = args.stateReason
        if (args.title !== undefined) body.title = args.title
        if (args.body !== undefined) body.body = args.body
        if (args.labels !== undefined) body.labels = args.labels
        if (args.assignees !== undefined) body.assignees = args.assignees
        if (Object.keys(body).length === 0) {
          throw new Error('github_update_issue 需要至少一个要修改的字段（state / stateReason / title / body / labels / assignees）。')
        }
        const { data } = await client.request('PATCH', `/repos/${owner}/${repo}/issues/${args.number}`, {
          body,
          signal: exec.signal,
        })
        return compactIssue(data, config.maxTextChars)
      },
    }),

    // ── pull requests ────────────────────────────────────────────────────────
    defineTool({
      name: 'github_create_pull_request',
      description: '创建 PR。head 分支必须已存在且有新 commit；跨仓库 PR 用 owner:branch 格式。',
      parameters: {
        ...repoParameters(),
        title: { type: 'string', required: true, description: 'PR 标题' },
        head: { type: 'string', required: true, description: '源分支，例如 my-feature 或 fork-owner:my-feature' },
        base: { type: 'string', required: true, description: '目标分支，例如 main' },
        body: { type: 'string', description: 'Markdown 描述（建议写明变更与测试方式）' },
        draft: { type: 'boolean', description: '是否创建为草稿 PR' },
        maintainerCanModify: { type: 'boolean', description: '是否允许维护者修改该分支，默认 true' },
        issue: { type: 'integer', description: '关联的 issue 编号（出现在 PR 时间线）' },
      },
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const { owner, repo } = repoOf(args, config)
        const { data } = await client.request('POST', `/repos/${owner}/${repo}/pulls`, {
          body: {
            title: args.title,
            head: args.head,
            base: args.base,
            ...(args.body === undefined ? {} : { body: args.body }),
            ...(args.draft === undefined ? {} : { draft: args.draft }),
            ...(args.maintainerCanModify === undefined ? {} : { maintainer_can_modify: args.maintainerCanModify }),
            ...(args.issue === undefined ? {} : { issue: args.issue }),
          },
          signal: exec.signal,
        })
        return compactPull(data, config.maxTextChars)
      },
    }),

    defineTool({
      name: 'github_create_review',
      description: '提交 PR 评审：整体评论（COMMENT）、批准（APPROVE）或请求修改（REQUEST_CHANGES），可带行内评论。不能对自己创建的 PR 使用 APPROVE/REQUEST_CHANGES。',
      parameters: {
        ...repoParameters(),
        number: { type: 'integer', required: true, description: 'PR 编号' },
        event: { type: 'string', required: true, enum: ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'], description: '评审结论' },
        body: { type: 'string', description: '评审总结正文' },
        comments: {
          type: 'array',
          description: '行内评论；每项 { path, line, body, side? }，line 是 diff 中新增行的行号',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true, description: '文件路径' },
              line: { type: 'integer', required: true, description: '文件中的行号（新增侧）' },
              body: { type: 'string', required: true, description: '评论内容' },
              side: { type: 'string', enum: ['LEFT', 'RIGHT'], description: 'diff 侧，默认 RIGHT' },
            },
          },
        },
      },
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const { owner, repo } = repoOf(args, config)
        const { data } = await client.request('POST', `/repos/${owner}/${repo}/pulls/${args.number}/reviews`, {
          body: {
            event: args.event,
            ...(args.body === undefined ? {} : { body: args.body }),
            ...(args.comments === undefined ? {} : { comments: args.comments }),
          },
          signal: exec.signal,
        })
        return {
          id: data?.id,
          state: data?.state,
          author: data?.user?.login,
          submittedAt: data?.submitted_at,
          url: data?.html_url,
        }
      },
    }),

    // ── file commits ─────────────────────────────────────────────────────────
    defineTool({
      name: 'github_write_file',
      description: '创建或更新仓库中的一个文本文件（通过 contents API 提交，内容按 UTF-8 编码为 base64）。更新已有文件时会自动获取当前 sha；也可显式传入 sha 做乐观并发控制。',
      parameters: {
        ...repoParameters(),
        path: { type: 'string', required: true, description: '仓库内路径，例如 docs/readme.md' },
        content: { type: 'string', required: true, description: '文件的完整新内容（UTF-8 文本）' },
        message: { type: 'string', required: true, description: 'commit message' },
        branch: { type: 'string', description: '目标分支，默认仓库默认分支' },
        sha: { type: 'string', description: '已知的当前文件 blob sha；省略时自动查询' },
      },
      output: jsonOutput(renderJson),
      timeoutMs,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const { owner, repo } = repoOf(args, config)
        let sha = args.sha
        if (sha === undefined) {
          try {
            const current = await client.request('GET', `/repos/${owner}/${repo}/contents/${encodePath(args.path)}`, {
              query: { ref: args.branch },
              signal: exec.signal,
            })
            if (current.data !== null && typeof current.data === 'object' && !Array.isArray(current.data)) sha = current.data.sha
          } catch (error) {
            // A missing file is the create path; anything else is a real failure.
            if (error?.status !== 404) throw error
          }
        }
        const { data } = await client.request('PUT', `/repos/${owner}/${repo}/contents/${encodePath(args.path)}`, {
          body: {
            message: args.message,
            content: Buffer.from(args.content, 'utf8').toString('base64'),
            ...(args.branch === undefined ? {} : { branch: args.branch }),
            ...(sha === undefined ? {} : { sha }),
          },
          signal: exec.signal,
        })
        return {
          action: sha === undefined ? 'created' : 'updated',
          path: data?.content?.path ?? args.path,
          blobSha: data?.content?.sha,
          commitSha: data?.commit?.sha,
          commitMessage: data?.commit?.message,
          branch: args.branch ?? '（仓库默认分支）',
          url: data?.commit?.html_url ?? data?.content?.html_url,
        }
      },
    }),
  ]
}

/**
 * Build the raw REST escape hatch.
 *
 * It is always registered — reading arbitrary endpoints is useful even in a
 * read-only composition — while `enableWrite: false` narrows `method` to `GET`.
 *
 * @param {object} deps - Tool dependencies.
 * @param {ReturnType<import('./rest.js').createClient>} deps.client - GitHub client.
 * @param {object} deps.config - Plugin config.
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition} Tool definition.
 */
export function createApiTool(deps) {
  const { client, config } = deps
  const readOnly = config.enableWrite !== true

  return defineTool({
    name: 'github_api',
    description: readOnly
      ? '直接调用 GitHub REST API（当前配置为只读，仅允许 GET），覆盖没有专用工具的接口。path 例如 /repos/owner/name/issues。'
      : '直接调用 GitHub REST API，覆盖没有专用工具的接口。path 例如 /repos/owner/name/issues，query/body 为 JSON 对象。修改类请求请谨慎。',
    parameters: {
      method: {
        type: 'string',
        required: true,
        enum: readOnly ? ['GET'] : ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
        description: 'HTTP 方法',
      },
      path: { type: 'string', required: true, description: '以 / 开头的 API 路径，可含查询串' },
      query: { type: 'json', description: '查询参数 JSON 对象' },
      body: { type: 'json', description: '请求体 JSON 对象' },
    },
    output: jsonOutput(renderJson),
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const [pathname, search] = String(args.path).split('?')
      const inline = new URLSearchParams(search ?? '')
      /** @type {Record<string, unknown>} */
      const query = {}
      for (const [key, value] of inline) query[key] = value
      if (args.query !== undefined && typeof args.query === 'object' && args.query !== null) {
        for (const [key, value] of Object.entries(args.query)) query[key] = value
      }
      const { status, data, nextUrl } = await client.request(args.method, pathname, {
        query,
        ...(args.body === undefined ? {} : { body: args.body }),
        signal: exec.signal,
      })
      const serialized = JSON.stringify(data)
      if (serialized !== undefined && serialized.length > config.maxTextChars) {
        return {
          status,
          truncated: true,
          nextPage: nextUrl ?? undefined,
          text: clip(serialized, config.maxTextChars),
        }
      }
      return { status, ...(nextUrl === undefined ? {} : { nextPage: nextUrl }), data }
    },
  })
}

/**
 * Percent-encode each path segment while keeping separators.
 * @param {string} path - Repository-relative path.
 * @returns {string} Encoded path.
 */
function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/')
}
