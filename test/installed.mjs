/**
 * Verify the *installed* copy — what the running harness actually loads, from
 * the profile directory rather than this checkout.
 *
 * It checks the three facts that decide whether the plugin works in the Web app:
 * the profile row points at a file that exists, the host half imports and
 * registers the tools plus the settings namespace, and the browser half is a
 * valid client bundle that requires only baseline modules.
 *
 * Usage: node test/installed.mjs [profile] [pluginDir]
 *   profile   defaults to `web` (or $DSH_PROFILE)
 *   pluginDir defaults to $DSH_HOME/profiles/<profile>/plugins/dsh-github-toolkit
 *
 * @module dsh-github-toolkit/test/installed
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const profile = process.argv[2] ?? process.env.DSH_PROFILE ?? 'web'
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const pluginDir = process.argv[3] ?? join(profileDir, 'plugins', 'dsh-github-toolkit')

let failures = 0

/**
 * Run one named check.
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

process.stdout.write(`installed copy check\n  profile:    ${profile}\n  plugin dir: ${pluginDir}\n\n`)

await check('every shipped file is present', () => {
  for (const file of ['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'lib/index.js', 'lib/client.js', 'lib/rest.js', 'lib/shared.js', 'lib/format.js', 'lib/tools-read.js', 'lib/tools-write.js']) {
    assert.ok(existsSync(join(pluginDir, file)), `missing ${file}`)
  }
})

await check('the manifest declares both halves and the listing requirements', () => {
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-github-toolkit')
  // `dsh.bundle` is what makes the package installable with `dsh plugin add`
  // (and what the marketplace catalogue checks first).
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh.client.inject), 'dsh.client.inject must be a string array')
  const clientExport = manifest.exports?.['./client']
  const clientPath = typeof clientExport === 'string' ? clientExport : clientExport?.default
  assert.equal(typeof clientPath, 'string', 'exports["./client"] must name the bundle')
  assert.ok(existsSync(join(pluginDir, clientPath)), `exports["./client"] → ${clientPath} does not exist`)
  // A bare-specifier row is resolved through the package search paths, which
  // needs the manifest to be importable as a subpath.
  assert.equal(manifest.exports?.['./package.json'], './package.json')
  for (const peer of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-credentials']) {
    assert.ok(manifest.peerDependencies?.[peer]?.includes('||'), `${peer} needs an explicit prerelease branch`)
  }
})

await check('the bundle patch mounts the package by name', () => {
  const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
  const patch = readFileSync(join(pluginDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /(^|\n)- insert:/, 'the bundle patch must be one insert')
  assert.match(patch, /id: tool-github/)
  assert.match(patch, new RegExp(`name: ${manifest.name}(\\s|$)`), 'the row must name the package itself')
})

await check('the profile row points at the host half', () => {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  assert.ok(existsSync(patchPath), `no patch layer at ${patchPath}`)
  const patch = readFileSync(patchPath, 'utf8')
  assert.match(patch, /id: tool-github/)
  assert.match(patch, /name: '\.\/plugins\/dsh-github-toolkit\/lib\/index\.js'/)
  const target = resolve(profileDir, 'plugins/dsh-github-toolkit/lib/index.js')
  assert.ok(existsSync(target), `the row resolves to a missing file: ${target}`)
})

await check('the host half imports and registers the tool set plus the settings namespace', async () => {
  const host = await import(pathToFileURL(join(pluginDir, 'lib/index.js')).href)
  const registered = []
  let installed
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition.name)
        return () => {
          registered.splice(registered.indexOf(definition.name), 1)
        }
      },
    },
    credentials: { async resolve() { return undefined } },
    logger: { warn() {}, info() {} },
    inject(services, callback) {
      if (!services.includes('settings')) return
      callback({ settings: { installSection(owner, namespace, schema, entry, hooks) { installed = namespace } } })
    },
  }
  host.apply(ctx, host.Config({}))
  assert.equal(host.name, 'tool-github')
  assert.equal(installed, 'tool-github', 'the settings namespace was not installed')
  assert.equal(registered.length, 18, `expected 18 tools, got ${registered.length}: ${registered.join(', ')}`)
  assert.ok(registered.includes('github_auth_status'))
  assert.ok(registered.includes('github_create_pull_request'))
})

await check('the browser half loads as a client bundle with only baseline requires', () => {
  const source = readFileSync(join(pluginDir, 'lib/client.js'), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load: (entry) => { registration = entry } } }
  // eslint-disable-next-line no-new-func -- the bundle is a plain browser script.
  new Function('window', 'fetch', source)(window, async () => new Response('{}'))
  assert.ok(registration !== undefined, 'the bundle never called window.__ModuleLoader__.load')
  assert.equal(registration.id, 'dsh-github-toolkit')
  const requires = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
  const allowed = new Set(['react', '@deepseek-ai/dsh-client-ui-primitives'])
  for (const name of requires) assert.ok(allowed.has(name), `undeclared browser dependency: ${name}`)
  const exportsObject = registration.factory((name) => {
    if (name === 'react') return { createElement: () => ({}), useState: () => [undefined, () => {}], useEffect: () => {} }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`undeclared module: ${name}`)
  })
  assert.equal(typeof exportsObject.apply, 'function')
  assert.ok(exportsObject.inject.includes('settingsScope'))
})

process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
