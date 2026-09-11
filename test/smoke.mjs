/**
 * Smoke test for `dsh-github-toolkit`.
 *
 * Part 1 — host contracts (deterministic): the plugin loads the way the Cordis
 * loader loads it, registers the expected tool set, installs the settings
 * namespace, re-registers tools when a settings commit flips the write mode,
 * and maps HTTP failures to actionable errors against stubbed responses.
 *
 * Part 2 — browser bundle (deterministic): `lib/client.js` is executed with a
 * stubbed `window.__ModuleLoader__`, `react`, and the UI primitives; the section
 * is rendered and its credential actions are exercised, which catches syntax,
 * dependency, and render faults without a browser.
 *
 * Part 3 — live network (best effort): with a deliberately invalid token a real
 * `api.github.com` call must fail as a mapped 401. Offline machines skip it.
 *
 * Run: node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as plugin from '../lib/index.js'
import { GitHubApiError, createClient, nextPageOf, parseNextLink } from '../lib/rest.js'
import { clip, compactIssue, compactPull, listValue, renderList, shortSha } from '../lib/format.js'
import { repoOf } from '../lib/shared.js'

const EXPECTED_READ_TOOLS = [
  'github_auth_status',
  'github_get_repository',
  'github_read_file',
  'github_search',
  'github_list_issues',
  'github_get_issue',
  'github_list_pull_requests',
  'github_get_pull_request',
  'github_list_commits',
  'github_list_branches',
  'github_get_checks',
]

const EXPECTED_WRITE_TOOLS = [
  'github_create_issue',
  'github_comment',
  'github_update_issue',
  'github_create_pull_request',
  'github_create_review',
  'github_write_file',
]

let failures = 0

/**
 * Run one named check, reporting pass/fail without aborting the suite.
 * @param {string} label - Check name.
 * @param {() => void | Promise<void>} body - Check body.
 * @returns {Promise<void>}
 */
async function check(label, body) {
  try {
    await body()
    process.stdout.write(`  ok   ${label}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/**
 * Register the plugin against a fake Cordis context that models the tool
 * registry's disposal contract and the settings service's attach hooks.
 * @param {object} rawConfig - Raw plugin config.
 * @returns {object} Harness handle.
 */
function loadHost(rawConfig = {}) {
  /** name → { definition, token } for the entries currently registered. */
  const liveTools = new Map()
  let settingsHooks
  let installedSection
  const config = plugin.Config(rawConfig)
  /** The section the fake settings service currently resolves. */
  let stored = { ...config }
  const logged = []

  const ctx = {
    tools: {
      register(definition) {
        const token = Symbol(definition.name)
        liveTools.set(definition.name, { definition, token })
        return () => {
          if (liveTools.get(definition.name)?.token === token) liveTools.delete(definition.name)
        }
      },
    },
    credentials: {
      async resolve() {
        return undefined
      },
    },
    logger: {
      warn(message) {
        logged.push(`warn:${message}`)
      },
      info(message) {
        logged.push(`info:${message}`)
      },
    },
    inject(services, callback) {
      if (!services.includes('settings')) return
      callback({
        settings: {
          installSection(owner, namespace, schema, entry, hooks) {
            installedSection = { namespace, schema, entry }
            settingsHooks = hooks
            // The real service attaches the active source, then re-judges.
            hooks.setSource(() => stored)
            hooks.onChange()
          },
        },
      })
    },
  }

  const apply = () => plugin.apply(ctx, config)
  apply()

  return {
    ctx,
    config,
    logged,
    tools: () => [...liveTools.values()].map((entry) => entry.definition),
    names: () => [...liveTools.keys()],
    installed: () => installedSection,
    /** Simulate the settings service committing a changed section. */
    commit(patch) {
      stored = { ...stored, ...patch }
      settingsHooks.setSource(() => stored)
      settingsHooks.onChange()
    },
  }
}

/**
 * A stubbed `fetch` returning one canned response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON payload or raw string.
 * @param {Record<string, string>} [headers] - Extra response headers.
 * @returns {(url: any, init: any) => Promise<Response>} Stub implementation.
 */
function stubFetch(status, payload, headers = {}) {
  return async () =>
    new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })
}

// ── part 1: host contracts ───────────────────────────────────────────────────
process.stdout.write('dsh-github-toolkit smoke test\n\npart 1 — host contracts (offline)\n')

await check('module exports name/inject/Config/apply and the settings namespace', () => {
  assert.equal(plugin.name, 'tool-github')
  assert.deepEqual(plugin.inject, ['tools', 'credentials'])
  assert.equal(plugin.SETTINGS_NAMESPACE, 'tool-github')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function')
})

const host = loadHost({ defaultOwner: 'octocat', defaultRepo: 'Hello-World' })

await check('registers every read tool, the escape hatch, then every write tool', () => {
  assert.deepEqual(host.names(), [...EXPECTED_READ_TOOLS, 'github_api', ...EXPECTED_WRITE_TOOLS])
})

await check('config defaults resolve', () => {
  assert.equal(host.config.tokenRef, 'GITHUB_TOKEN')
  assert.equal(host.config.apiBase, 'https://api.github.com')
  assert.equal(host.config.perPage, 30)
  assert.equal(host.config.enableWrite, true)
})

await check('installs the tool-github settings namespace with the composition entry', () => {
  const section = host.installed()
  assert.ok(section !== undefined, 'no settings section installed')
  assert.equal(section.namespace, 'tool-github')
  assert.equal(typeof section.schema, 'function')
  assert.equal(section.entry.enableWrite, true)
})

await check('a settings commit flips the write mode without a reload', () => {
  host.commit({ enableWrite: false })
  assert.deepEqual(host.names(), [...EXPECTED_READ_TOOLS, 'github_api'])
  const api = host.tools().find((tool) => tool.name === 'github_api')
  assert.deepEqual(api.parameters.properties.method.enum, ['GET'])
  assert.match(api.description, /只读/)

  host.commit({ enableWrite: true, perPage: 50, defaultOwner: 'deepseek-ai' })
  assert.deepEqual(host.names(), [...EXPECTED_READ_TOOLS, 'github_api', ...EXPECTED_WRITE_TOOLS])
  const again = host.tools().find((tool) => tool.name === 'github_api')
  assert.deepEqual(again.parameters.properties.method.enum, ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])
})

await check('an unusable settings commit is refused instead of half-applied', () => {
  host.commit({ perPage: 500 })
  const api = host.tools().find((tool) => tool.name === 'github_api')
  assert.ok(api.parameters.properties.method.enum.length > 1, 'write mode must survive a refused commit')
  assert.ok(host.logged.some((line) => line.includes('忽略无效设置')), 'the refusal must be logged')
  host.commit({ perPage: 30 })
})

await check('every tool declares an object parameter schema and a JSON output renderer', () => {
  for (const tool of host.tools()) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 10, `${tool.name} needs a real description`)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.parameters.type, 'object', `${tool.name} must take an object parameter root`)
    assert.ok(tool.output?.schema !== undefined, `${tool.name} declares no output schema`)
    assert.equal(typeof tool.output.render, 'function')
  }
})

await check('owner/repo stay optional so a settings default can bind them later', () => {
  const repo = host.tools().find((tool) => tool.name === 'github_get_repository')
  assert.deepEqual(repo.parameters.required ?? [], [])
  const file = host.tools().find((tool) => tool.name === 'github_read_file')
  assert.deepEqual(file.parameters.required, ['path'])
})

await check('missing repository coordinates produce an actionable error', () => {
  assert.throws(() => repoOf({}, {}), /缺少仓库定位信息/)
  assert.match(String(new Error().message) + '', /^$/)
  assert.deepEqual(repoOf({ owner: 'a', repo: 'b' }, { defaultOwner: 'x', defaultRepo: 'y' }), { owner: 'a', repo: 'b' })
  assert.deepEqual(repoOf({}, { defaultOwner: 'x', defaultRepo: 'y' }), { owner: 'x', repo: 'y' })
  assert.throws(() => repoOf({}, { defaultOwner: '', defaultRepo: 'y' }), /设置 → GitHub/)
})

/**
 * Whether any object in a value holds an `undefined` property.
 * @param {unknown} value - Value to walk.
 * @returns {boolean} True when `undefined` appears anywhere.
 */
function containsUndefined(value) {
  if (Array.isArray(value)) return value.some(containsUndefined)
  if (value === null || typeof value !== 'object') return false
  return Object.values(value).some((entry) => entry === undefined || containsUndefined(entry))
}

await check('a tool result is lossless JSON: absent fields are dropped, never undefined', async () => {
  // The harness materializes every canonical tool value as JSON, so one
  // `undefined` property invalidates the whole result. This is the failure the
  // wrapper in lib/index.js exists to prevent.
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const body = String(url).includes('/rate_limit')
      ? { resources: { core: { limit: 5000, remaining: 4999, reset: 1800000000 } } }
      // No `name` and no scope header: exactly the fields the tool omits.
      : { login: 'octocat', type: 'User' }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const ambient = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'ghp_stub_token'
  try {
    const stubbed = loadHost()
    const auth = stubbed.tools().find((tool) => tool.name === 'github_auth_status')
    const value = await auth.execute({}, { signal: new AbortController().signal })
    assert.equal(containsUndefined(value), false, 'a canonical value must not contain undefined')
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value, 'a canonical value must survive a JSON round trip')
    assert.equal(value.login, 'octocat')
    // Absent upstream → absent here; the round trip drops the key instead of
    // shipping an `undefined` the harness would reject.
    assert.equal(Object.hasOwn(value, 'name'), false)
    assert.match(value.scopes, /未报告/)
    assert.equal(value.rateLimit.remaining, 4999)
    assert.equal(value.rateLimit.reset, new Date(1800000000 * 1000).toISOString())
  } finally {
    globalThis.fetch = original
    if (ambient === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = ambient
  }
})

await check('render functions emit non-empty text blocks', () => {
  const issue = host.tools().find((tool) => tool.name === 'github_get_issue')
  const blocks = issue.output.render({}, { number: 1, title: 'bug', state: 'open' })
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /"title": "bug"/)
  const search = host.tools().find((tool) => tool.name === 'github_search')
  const listBlocks = search.output.render({ kind: 'repositories' }, listValue('搜索', [{ fullName: 'a/b', stars: 3, url: 'u' }]))
  assert.match(listBlocks[0].text, /a\/b ★3/)
})

await check('curation bounds unbounded GitHub payloads', () => {
  const issue = compactIssue(
    { number: 7, title: 't', state: 'open', body: 'x'.repeat(500), user: { login: 'octocat' }, labels: [{ name: 'bug' }, 'docs'] },
    100,
  )
  assert.equal(issue.author, 'octocat')
  assert.deepEqual(issue.labels, ['bug', 'docs'])
  assert.ok(issue.body.length < 200, 'body must be clipped')
  assert.match(issue.body, /已截断/)
  const pull = compactPull({ number: 2, head: { label: 'o:b', sha: 'abcdef1234567' }, base: { ref: 'main' } }, 100)
  assert.equal(pull.head, 'o:b @ abcdef1')
  assert.equal(shortSha('abcdef1234567'), 'abcdef1')
  assert.equal(clip(undefined, 10), undefined)
})

await check('list rendering reports totals, next page, and empty results', () => {
  const rendered = renderList(listValue('issues', [{ number: 1, title: 'a' }], { totalCount: 5, nextPage: 2 }), (item) => `#${item.number}`)
  assert.match(rendered[0].text, /总数 5/)
  assert.match(rendered[0].text, /page=2/)
  assert.match(rendered[0].text, /- #1/)
  assert.match(renderList(listValue('issues', []))[0].text, /无结果/)
})

await check('link headers drive pagination', () => {
  const header = '<https://api.github.com/repos/a/b/issues?page=2>; rel="next", <https://api.github.com/repos/a/b/issues?page=9>; rel="last"'
  assert.equal(parseNextLink(header), 'https://api.github.com/repos/a/b/issues?page=2')
  assert.equal(nextPageOf(parseNextLink(header)), 2)
  assert.equal(parseNextLink(null), undefined)
})

await check('the REST client follows live config instead of its creation snapshot', async () => {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    // The plugin passes getters over one mutable object; the client must read
    // through them per request rather than copying values at creation.
    const options = {
      apiBase: 'https://api.github.com',
      timeoutMs: 1000,
      userAgent: 'test',
      credentialLabel: 'GITHUB_TOKEN',
      resolveToken: async () => 'token',
    }
    const client = createClient(options)
    await client.request('GET', '/user')
    options.apiBase = 'https://github.example.com/api/v3'
    await client.request('GET', '/user')
    assert.equal(seen[0], 'https://api.github.com/user')
    assert.equal(seen[1], 'https://github.example.com/api/v3/user')
  } finally {
    globalThis.fetch = original
  }
})

await check('401 maps to a credential remediation message', async () => {
  const original = globalThis.fetch
  globalThis.fetch = stubFetch(401, { message: 'Bad credentials' })
  try {
    const client = createClient({
      apiBase: 'https://api.github.com',
      userAgent: 'test',
      timeoutMs: 1000,
      credentialLabel: 'GITHUB_TOKEN',
      resolveToken: async () => 'ghp_invalid',
    })
    await assert.rejects(client.request('GET', '/user'), (error) => {
      assert.ok(error instanceof GitHubApiError)
      assert.equal(error.status, 401)
      assert.match(error.message, /认证失败/)
      assert.match(error.hint, /GITHUB_TOKEN/)
      return true
    })
  } finally {
    globalThis.fetch = original
  }
})

await check('403 rate-limit, 404, and 422 map to distinct guidance', async () => {
  const original = globalThis.fetch
  try {
    const client = (status, payload, headers) => {
      globalThis.fetch = stubFetch(status, payload, headers)
      return createClient({
        apiBase: 'https://api.github.com',
        userAgent: 'test',
        timeoutMs: 1000,
        credentialLabel: 'GITHUB_TOKEN',
        resolveToken: async () => 'ghp_invalid',
      })
    }
    await assert.rejects(
      client(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': '1800000000' }).request('GET', '/user'),
      (error) => {
        assert.match(error.message, /速率受限/)
        assert.equal(error.rateLimit.remaining, 0)
        assert.match(error.rateLimit.reset, /^\d{4}-/)
        return true
      },
    )
    await assert.rejects(client(404, { message: 'Not Found' }).request('GET', '/repos/a/b'), /404/)
    await assert.rejects(
      client(422, { message: 'Validation Failed', errors: [{ message: 'No commits between main and dev' }] }).request('PATCH', '/repos/a/b'),
      (error) => {
        assert.match(error.message, /422/)
        assert.match(error.detail, /No commits between main and dev/)
        return true
      },
    )
  } finally {
    globalThis.fetch = original
  }
})

await check('a missing token fails before touching the network, pointing at the GUI', async () => {
  const ambient = process.env.GITHUB_TOKEN
  delete process.env.GITHUB_TOKEN
  try {
    const bare = loadHost()
    const auth = bare.tools().find((tool) => tool.name === 'github_auth_status')
    await assert.rejects(
      auth.execute({}, { signal: new AbortController().signal }),
      (error) => {
        assert.match(error.message, /未找到 GitHub 令牌/)
        assert.match(error.hint, /设置 → GitHub/)
        return true
      },
    )
  } finally {
    if (ambient !== undefined) process.env.GITHUB_TOKEN = ambient
  }
})

// ── part 2: browser bundle ───────────────────────────────────────────────────
process.stdout.write('\npart 2 — browser bundle (offline)\n')

const ALLOWED_BROWSER_REQUIRES = new Set(['react', '@deepseek-ai/dsh-client-ui-primitives'])

/**
 * Minimal React runtime: enough for `createElement`, `useState`, `useEffect`,
 * and function components, so the real section code can be rendered (including
 * the effect that fills the configuration form from the settings snapshot).
 * @returns {{React: object, render: (element: any) => {text: string, inputs: string[]}}} Runtime handle.
 */
function createReactRuntime() {
  /** Per-component hook slots, keyed by the component function. */
  const components = new Map()
  let pending = false
  const slotOf = (type) => {
    if (!components.has(type)) components.set(type, { hooks: [], ran: new Set(), cursor: 0 })
    return components.get(type)
  }
  const React = {
    createElement: (type, props, ...children) => {
      const flat = children.flat()
      // Real React projects the third argument onto `props.children`; component
      // stubs read it there, so the stand-in must do the same.
      const withChildren = flat.length === 0
        ? (props ?? {})
        : { ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat }
      return { type, props: withChildren, children: flat }
    },
    useState(initial) {
      const slot = slotOf(React.current)
      const index = slot.cursor++
      if (slot.hooks.length <= index) slot.hooks[index] = typeof initial === 'function' ? initial() : initial
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slot.hooks[index]) : next
        if (value !== slot.hooks[index]) {
          slot.hooks[index] = value
          pending = true
        }
      }
      return [slot.hooks[index], setState]
    },
    useEffect(effect) {
      const slot = slotOf(React.current)
      const index = slot.cursor++
      if (slot.ran.has(index)) return
      slot.ran.add(index)
      effect()
    },
    current: undefined,
  }
  const renderNode = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(renderNode).filter(Boolean).join(' ')
    if (typeof node.type === 'function') {
      const previous = React.current
      React.current = node.type
      const slot = slotOf(node.type)
      slot.cursor = 0
      try {
        return renderNode(node.type(node.props))
      } finally {
        React.current = previous
      }
    }
    if (node.type === 'input' && typeof node.props?.type === 'string') renderedInputs.push(node.props.type)
    return renderNode(node.children)
  }
  let renderedInputs = []
  return {
    React,
    render(element) {
      let text = ''
      for (let pass = 0; pass < 12; pass += 1) {
        pending = false
        renderedInputs = []
        text = renderNode(element)
        if (!pending) break
      }
      return { text, inputs: [...renderedInputs] }
    },
  }
}

/**
 * Execute `lib/client.js` the way the browser shell does.
 * @param {(name: string) => any} requireImpl - Module table stand-in.
 * @param {any} fetchImpl - `fetch` stand-in visible to the bundle.
 * @returns {any} The registration `{ id, factory }`.
 */
function loadClientBundle(requireImpl, fetchImpl) {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (entry) => { registration = entry } } }
  // eslint-disable-next-line no-new-func -- the bundle is a plain browser script.
  new Function('window', 'fetch', source)(window, fetchImpl)
  assert.ok(registration !== undefined, 'the bundle never registered itself')
  return registration
}

/** Collect every string rendered in an element tree (no component expansion). */
function collectText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(collectText).join(' ')
  if (typeof node === 'object' && Array.isArray(node.children)) return collectText(node.children)
  return ''
}

const clientRequires = []
const runtime = createReactRuntime()
const reactStub = runtime.React
const primitivesStub = {
  Button: (props) => ({ type: 'Button', props, children: [props.children] }),
  Switch: (props) => ({ type: 'Switch', props, children: [] }),
  Tag: (props) => ({ type: 'Tag', props, children: [props.children] }),
}
const bundleFetchCalls = []
let bundleFetchImpl = async () => new Response('{}', { status: 200 })

/** The module table the bundle sees; every request is recorded. */
function browserRequire(name) {
  clientRequires.push(name)
  if (name === 'react') return reactStub
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`browser bundle required an undeclared module: ${name}`)
}

const bundle = loadClientBundle(browserRequire, (...args) => {
  bundleFetchCalls.push(args)
  return bundleFetchImpl(...args)
})

await check('the bundle registers under the package name', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  // The host publishes the browser module under the manifest's package name, so
  // a bundle that registers any other id is never materialized.
  assert.equal(bundle.id, manifest.name)
  assert.equal(typeof bundle.factory, 'function')
})

const clientHalf = bundle.factory(browserRequire)

await check('only baseline modules are required', () => {
  assert.deepEqual([...new Set(clientRequires)].sort(), [...ALLOWED_BROWSER_REQUIRES].sort())
  assert.equal(typeof clientHalf.apply, 'function')
  assert.ok(clientHalf.inject.includes('slots'))
  assert.ok(clientHalf.inject.includes('remote.credentials'))
  assert.ok(clientHalf.inject.includes('settingsScope'))
})

// A fake client context: settings scope + credential Remote + slots ledger.
let scopeSnapshot = {
  status: 'ready',
  value: { tokenRef: 'GITHUB_TOKEN', apiBase: 'https://api.github.com', timeoutMs: 30000, perPage: 30, enableWrite: true },
  base: {},
  user: {},
  revision: 1,
  writable: true,
  mode: 'host',
}
const scopeListeners = new Set()
const credentialCalls = []
const fakeScope = {
  getSnapshot: () => scopeSnapshot,
  subscribe(listener) {
    scopeListeners.add(listener)
    return () => scopeListeners.delete(listener)
  },
  async set(field, value) {
    scopeSnapshot = { ...scopeSnapshot, value: { ...scopeSnapshot.value, [field]: value }, user: { ...scopeSnapshot.user, [field]: value } }
    for (const listener of [...scopeListeners]) listener()
  },
  async unset(field) {
    const { [field]: _dropped, ...rest } = scopeSnapshot.user
    scopeSnapshot = { ...scopeSnapshot, user: rest }
    for (const listener of [...scopeListeners]) listener()
  },
}
const registrations = []
const clientCtx = {
  slots: {
    inject(_name, callback) {
      callback()
    },
    register(options, Component) {
      registrations.push({ options, Component })
      return () => {}
    },
  },
  settingsScope: {
    bind(spec) {
      assert.equal(spec.namespace, 'tool-github')
      return fakeScope
    },
  },
  remote: {
    credentials: {
      async describe(refs) {
        return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: false, writable: true }])) }
      },
      async set(ref, value) {
        credentialCalls.push(['set', ref, value])
        return { ok: true }
      },
      async unset(ref) {
        credentialCalls.push(['unset', ref])
        return { ok: true }
      },
    },
  },
}

clientHalf.apply(clientCtx)

await check('apply registers one GitHub settings section', () => {
  assert.equal(registrations.length, 1)
  const { options } = registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'github')
  assert.equal(options.label(), 'GitHub')
  assert.equal(typeof options.inject().api.getSnapshot, 'function')
})

await check('rendering the section shows the credential and configuration controls', () => {
  const { options, Component } = registrations[0]
  const store = options.inject().api
  const element = reactStub.createElement(Component, { api: store, close: () => {} })
  const { text, inputs } = runtime.render(element)
  for (const expected of ['访问令牌', '测试连接', '保存令牌', '默认仓库与行为', '默认 owner', '默认仓库', '凭证引用名', 'API 地址', '每页条数', '恢复默认', '保存配置']) {
    assert.ok(text.includes(expected), `section is missing «${expected}»`)
  }
  assert.ok(inputs.includes('password'), 'the token field must be a password input')
  assert.ok(inputs.filter((type) => type === 'text').length >= 6, 'the configuration form must render its text inputs')
})

await check('saving a token writes it to the credential store under the configured ref', async () => {
  const store = registrations[0].options.inject().api
  credentialCalls.length = 0
  const ok = await store.saveToken('  ghp_example_token  ')
  assert.equal(ok, true)
  assert.deepEqual(credentialCalls, [['set', 'GITHUB_TOKEN', 'ghp_example_token']])
  assert.match(store.getSnapshot().notice.text, /已保存/)
})

await check('an empty token is refused without touching the store', async () => {
  const store = registrations[0].options.inject().api
  credentialCalls.length = 0
  assert.equal(await store.saveToken('   '), false)
  assert.deepEqual(credentialCalls, [])
  assert.match(store.getSnapshot().notice.text, /请先粘贴/)
})

await check('clearing the token goes through the credential store', async () => {
  const store = registrations[0].options.inject().api
  credentialCalls.length = 0
  await store.clearToken()
  assert.deepEqual(credentialCalls, [['unset', 'GITHUB_TOKEN']])
})

await check('the connection test talks to api.github.com from the page', async () => {
  bundleFetchImpl = async () =>
    new Response(JSON.stringify({ login: 'octocat', name: 'The Octocat' }), {
      status: 200,
      headers: {
        'x-oauth-scopes': 'repo, read:org',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
      },
    })
  const store = registrations[0].options.inject().api
  bundleFetchCalls.length = 0
  await store.probeToken('ghp_example_token')
  const [url, init] = bundleFetchCalls[0]
  assert.equal(url, 'https://api.github.com/user')
  assert.equal(init.headers.authorization, 'Bearer ghp_example_token')
  const probe = store.getSnapshot().probe
  assert.equal(probe.ok, true)
  assert.match(probe.text, /@octocat/)
  assert.match(probe.text, /repo, read:org/)
  assert.match(probe.text, /4999\/5000/)
})

await check('a rejected connection test surfaces GitHub’s own message', async () => {
  bundleFetchImpl = async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
  const store = registrations[0].options.inject().api
  await store.probeToken('bad')
  const probe = store.getSnapshot().probe
  assert.equal(probe.ok, false)
  assert.match(probe.text, /401/)
  assert.match(probe.text, /Bad credentials/)
})

await check('saving configuration writes the settings namespace', async () => {
  const store = registrations[0].options.inject().api
  await store.saveConfig({
    tokenRef: 'GITHUB_TOKEN',
    apiBase: '',
    defaultOwner: 'deepseek-ai',
    defaultRepo: 'deepseek-harness',
    timeoutMs: '45000',
    perPage: '50',
    enableWrite: false,
  })
  assert.deepEqual(scopeSnapshot.value.defaultOwner, 'deepseek-ai')
  assert.equal(scopeSnapshot.value.defaultRepo, 'deepseek-harness')
  assert.equal(scopeSnapshot.value.timeoutMs, 45000)
  assert.equal(scopeSnapshot.value.perPage, 50)
  assert.equal(scopeSnapshot.value.enableWrite, false)
  // An empty text field clears its override instead of storing an empty string.
  assert.equal(scopeSnapshot.user.apiBase, undefined)
  assert.match(store.getSnapshot().notice.text, /配置已保存/)
})

await check('an invalid configuration is rejected before any write', async () => {
  const store = registrations[0].options.inject().api
  const before = JSON.stringify(scopeSnapshot)
  await store.saveConfig({
    tokenRef: 'GITHUB_TOKEN',
    apiBase: 'https://api.github.com',
    defaultOwner: '',
    defaultRepo: '',
    timeoutMs: '0',
    perPage: '30',
    enableWrite: true,
  })
  assert.equal(JSON.stringify(scopeSnapshot), before, 'a refused save must not write')
  assert.match(store.getSnapshot().notice.text, /保存失败/)
  await store.saveConfig({
    tokenRef: 'has spaces',
    apiBase: 'https://api.github.com',
    defaultOwner: '',
    defaultRepo: '',
    timeoutMs: '30000',
    perPage: '30',
    enableWrite: true,
  })
  assert.equal(JSON.stringify(scopeSnapshot), before, 'an invalid credential name must not write')
})

await check('reset clears exactly the fields this section owns', async () => {
  const store = registrations[0].options.inject().api
  await store.resetConfig()
  assert.deepEqual(scopeSnapshot.user, {})
  assert.match(store.getSnapshot().notice.text, /已恢复默认/)
})

// ── part 3: live network ─────────────────────────────────────────────────────
process.stdout.write('\npart 3 — live network (best effort)\n')

await check('live api.github.com rejects a bad token as a mapped 401', async () => {
  const ambient = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'ghp_this_token_is_intentionally_invalid'
  try {
    const live = loadHost()
    const repo = live.tools().find((tool) => tool.name === 'github_get_repository')
    try {
      await repo.execute({ owner: 'octocat', repo: 'Hello-World' }, { signal: AbortSignal.timeout(15000) })
      throw new Error('an invalid token unexpectedly succeeded')
    } catch (error) {
      if (error instanceof GitHubApiError) {
        assert.equal(error.status, 401, `expected 401, got ${error.status}: ${error.message}`)
        return
      }
      if (/无法连接 GitHub|超时/.test(error?.message ?? '')) {
        process.stdout.write('       (skipped: no network reachability from this machine)\n')
        return
      }
      throw error
    }
  } finally {
    if (ambient === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = ambient
  }
})

process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
