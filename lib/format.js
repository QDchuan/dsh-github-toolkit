/**
 * Curation and rendering helpers: turn raw GitHub payloads into small canonical
 * values, then render them for the model.
 *
 * The canonical value is what a programmatic (PTC) caller receives; the render
 * is what enters the conversation. Both stay bounded — GitHub returns far more
 * per object than a model needs, and every unbounded field is a token leak.
 *
 * @module dsh-github-toolkit/format
 */

/**
 * Bound a text field, marking the cut so the model knows it is partial.
 * @param {unknown} value - Candidate text.
 * @param {number} max - Maximum characters to keep.
 * @returns {string | undefined} The bounded text, or undefined for empty input.
 */
export function clip(value, max) {
  if (typeof value !== 'string' || value === '') return undefined
  return value.length <= max ? value : `${value.slice(0, max)}\n…（已截断，原文 ${value.length} 字符）`
}

/**
 * Shorten a commit SHA for display.
 * @param {unknown} sha - Full SHA.
 * @returns {string | undefined} Seven-character prefix.
 */
export function shortSha(sha) {
  return typeof sha === 'string' && sha.length >= 7 ? sha.slice(0, 7) : (typeof sha === 'string' ? sha : undefined)
}

/**
 * Keep the login of a GitHub user-shaped object.
 * @param {any} user - `user`, `actor`, or `author` payload.
 * @returns {string | undefined} Login name.
 */
export function loginOf(user) {
  if (user === null || typeof user !== 'object') return undefined
  return typeof user.login === 'string' ? user.login : undefined
}

/**
 * Keep label names.
 * @param {any} labels - Label array, possibly of strings or objects.
 * @returns {string[] | undefined} Label names.
 */
export function labelNames(labels) {
  if (!Array.isArray(labels)) return undefined
  const names = labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter((name) => typeof name === 'string')
  return names.length === 0 ? undefined : names
}

/**
 * Project a repository payload.
 * @param {any} repo - Raw repository.
 * @returns {object} Curated repository.
 */
export function compactRepo(repo) {
  if (repo === null || typeof repo !== 'object') return {}
  return {
    fullName: repo.full_name,
    private: repo.private,
    description: repo.description ?? undefined,
    defaultBranch: repo.default_branch,
    language: repo.language ?? undefined,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    openIssues: repo.open_issues_count,
    topics: Array.isArray(repo.topics) && repo.topics.length > 0 ? repo.topics : undefined,
    archived: repo.archived === true ? true : undefined,
    pushedAt: repo.pushed_at,
    url: repo.html_url,
  }
}

/**
 * Project an issue or pull-request payload (the issues API returns both).
 * @param {any} issue - Raw issue.
 * @param {number} maxTextChars - Body budget.
 * @returns {object} Curated issue.
 */
export function compactIssue(issue, maxTextChars) {
  if (issue === null || typeof issue !== 'object') return {}
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    stateReason: issue.state_reason ?? undefined,
    author: loginOf(issue.user),
    labels: labelNames(issue.labels),
    assignees: Array.isArray(issue.assignees) ? issue.assignees.map(loginOf).filter(Boolean) : undefined,
    comments: issue.comments,
    isPullRequest: issue.pull_request !== undefined ? true : undefined,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at ?? undefined,
    url: issue.html_url,
    body: clip(issue.body, maxTextChars),
  }
}

/**
 * Project a pull-request payload.
 * @param {any} pull - Raw pull request.
 * @param {number} maxTextChars - Body budget.
 * @returns {object} Curated pull request.
 */
export function compactPull(pull, maxTextChars) {
  if (pull === null || typeof pull !== 'object') return {}
  return {
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft === true ? true : undefined,
    merged: pull.merged === true ? true : undefined,
    mergeable: pull.mergeable ?? undefined,
    mergeableState: pull.mergeable_state ?? undefined,
    author: loginOf(pull.user),
    labels: labelNames(pull.labels),
    requestedReviewers: Array.isArray(pull.requested_reviewers)
      ? pull.requested_reviewers.map(loginOf).filter(Boolean)
      : undefined,
    head: pull.head === undefined ? undefined : `${pull.head.label} @ ${shortSha(pull.head.sha)}`,
    base: pull.base === undefined ? undefined : pull.base.ref,
    commits: pull.commits,
    changedFiles: pull.changed_files,
    additions: pull.additions,
    deletions: pull.deletions,
    comments: pull.comments,
    reviewComments: pull.review_comments,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    mergedAt: pull.merged_at ?? undefined,
    url: pull.html_url,
    body: clip(pull.body, maxTextChars),
  }
}

/**
 * Project a commit payload.
 * @param {any} commit - Raw commit (list or single form).
 * @param {number} maxTextChars - Message budget.
 * @returns {object} Curated commit.
 */
export function compactCommit(commit, maxTextChars) {
  if (commit === null || typeof commit !== 'object') return {}
  const detail = commit.commit ?? {}
  return {
    sha: shortSha(commit.sha),
    fullSha: commit.sha,
    message: clip(typeof detail.message === 'string' ? detail.message.split('\n')[0] : undefined, 200),
    messageBody: clip(detail.message, maxTextChars),
    author: loginOf(commit.author) ?? detail.author?.name,
    authorEmail: detail.author?.email ?? undefined,
    committer: loginOf(commit.committer) ?? detail.committer?.name,
    date: detail.author?.date ?? detail.committer?.date,
    parents: Array.isArray(commit.parents) ? commit.parents.map((parent) => shortSha(parent.sha)) : undefined,
    url: commit.html_url,
  }
}

/**
 * Project an issue/PR comment.
 * @param {any} comment - Raw comment.
 * @param {number} maxTextChars - Body budget.
 * @returns {object} Curated comment.
 */
export function compactComment(comment, maxTextChars) {
  if (comment === null || typeof comment !== 'object') return {}
  return {
    id: comment.id,
    author: loginOf(comment.user),
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    url: comment.html_url,
    body: clip(comment.body, maxTextChars),
  }
}

/**
 * Project a check run.
 * @param {any} run - Raw check run.
 * @returns {object} Curated check run.
 */
export function compactCheckRun(run) {
  if (run === null || typeof run !== 'object') return {}
  return {
    name: run.name,
    status: run.status,
    conclusion: run.conclusion ?? undefined,
    startedAt: run.started_at ?? undefined,
    completedAt: run.completed_at ?? undefined,
    url: run.html_url ?? undefined,
    output: run.output === undefined ? undefined : {
      title: run.output.title ?? undefined,
      summary: clip(run.output.summary, 600),
    },
  }
}

/**
 * Project a branch.
 * @param {any} branch - Raw branch.
 * @returns {object} Curated branch.
 */
export function compactBranch(branch) {
  if (branch === null || typeof branch !== 'object') return {}
  return {
    name: branch.name,
    protected: branch.protected === true ? true : undefined,
    sha: shortSha(branch.commit?.sha),
    url: branch._links?.html ?? undefined,
  }
}

/**
 * Render one canonical value as a single pretty-printed JSON text block.
 * @param {unknown} value - Canonical value.
 * @returns {{type: 'text', text: string}[]} Model-facing content.
 */
export function renderJson(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Render a paginated list with a header and one line per item.
 * @param {object} page - Canonical list value.
 * @param {string} page.summary - Human header, e.g. `issues（state=open）`.
 * @param {unknown[]} page.items - Curated items.
 * @param {number} [page.totalCount] - Server-reported total, when known.
 * @param {number} [page.nextPage] - Next page number, when more results exist.
 * @param {(item: any) => string} line - One line per item.
 * @returns {{type: 'text', text: string}[]} Model-facing content.
 */
export function renderList(page, line) {
  const items = Array.isArray(page.items) ? page.items : []
  const head = [
    `${page.summary}：本页 ${items.length} 项`,
    page.totalCount === undefined ? undefined : `总数 ${page.totalCount}`,
    page.nextPage === undefined ? '没有更多页' : `还有下一页（page=${page.nextPage}）`,
  ].filter((part) => part !== undefined).join('，')
  if (items.length === 0) return [{ type: 'text', text: `${head}\n（无结果）` }]
  const body = items.map((item) => `- ${line(item)}`).join('\n')
  return [{ type: 'text', text: `${head}\n${body}` }]
}

/**
 * Build the canonical shape shared by every list tool.
 * @param {string} summary - Human header.
 * @param {unknown[]} items - Curated items.
 * @param {object} [extra] - `totalCount` and `nextPage`.
 * @returns {object} Canonical list value.
 */
export function listValue(summary, items, extra = {}) {
  return {
    summary,
    items,
    ...(extra.totalCount === undefined ? {} : { totalCount: extra.totalCount }),
    ...(extra.nextPage === undefined ? {} : { nextPage: extra.nextPage, hasMore: true }),
  }
}

/**
 * Clamp a requested page size into GitHub's accepted range.
 * @param {unknown} value - Requested `perPage`.
 * @param {number} fallback - Configured default.
 * @returns {number} An integer in `[1, 100]`.
 */
export function perPageOf(value, fallback) {
  const wanted = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(100, Math.max(1, wanted))
}
