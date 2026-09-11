/**
 * Parameter and pagination helpers shared by every GitHub tool.
 *
 * `owner`/`repo` are always optional in the model-facing schema because the
 * settings page can bind defaults at any time; a call that supplies neither
 * the arguments nor a configured default fails with an actionable message.
 *
 * @module dsh-github-toolkit/shared
 */

/**
 * The `owner` parameter.
 * @returns {object} Parameter spec.
 */
export function ownerParameter() {
  return {
    type: 'string',
    description: '仓库 owner（用户名或组织名），例如 deepseek-ai；省略时使用设置里配置的默认 owner',
  }
}

/**
 * The `repo` parameter.
 * @returns {object} Parameter spec.
 */
export function repoParameter() {
  return {
    type: 'string',
    description: '仓库名，例如 deepseek-harness；省略时使用设置里配置的默认仓库',
  }
}

/**
 * The shared `owner` + `repo` pair.
 * @returns {{owner: object, repo: object}} Parameter specs.
 */
export function repoParameters() {
  return { owner: ownerParameter(), repo: repoParameter() }
}

/**
 * Resolve the repository a call targets.
 * @param {object} args - Validated tool arguments.
 * @param {object} config - The live plugin config.
 * @returns {{owner: string, repo: string}} Repository coordinates.
 * @throws {Error} When neither the arguments nor the settings bind a repository.
 */
export function repoOf(args, config) {
  const owner = args.owner ?? config.defaultOwner
  const repo = args.repo ?? config.defaultRepo
  if (owner === undefined || owner === '' || repo === undefined || repo === '') {
    throw new Error(
      '缺少仓库定位信息：请在参数中提供 owner 与 repo，'
      + '或在「设置 → GitHub → 默认仓库」里填写默认值（保存后立即生效）。',
    )
  }
  return { owner: String(owner), repo: String(repo) }
}

/**
 * The `page` parameter shared by list tools.
 * @returns {object} Parameter spec.
 */
export function pageParameter() {
  return { type: 'integer', description: '页码，从 1 开始；默认 1' }
}

/**
 * The `perPage` parameter shared by list tools.
 * @param {object} config - Plugin config.
 * @returns {object} Parameter spec.
 */
export function perPageParameter(config) {
  return {
    type: 'integer',
    description: `每页条数（1-100），默认 ${config.perPage}`,
  }
}

/**
 * Build the query object for one list request.
 * @param {object} args - Validated tool arguments.
 * @param {object} config - Plugin config.
 * @param {Record<string, unknown>} [extra] - Additional query parameters.
 * @returns {Record<string, unknown>} Query parameters for the REST call.
 */
export function pageQuery(args, config, extra = {}) {
  const page = typeof args.page === 'number' && Number.isFinite(args.page) ? Math.max(1, Math.trunc(args.page)) : 1
  const perPage = typeof args.perPage === 'number' && Number.isFinite(args.perPage)
    ? Math.min(100, Math.max(1, Math.trunc(args.perPage)))
    : config.perPage
  return { per_page: perPage, page, ...extra }
}

/**
 * The standard `output` declaration: a JSON canonical value rendered as JSON.
 * @param {(value: any) => {type: 'text', text: string}[]} render - Renderer.
 * @returns {object} Output declaration.
 */
export function jsonOutput(render) {
  return { schema: { type: 'json' }, render: (_args, value) => render(value) }
}
