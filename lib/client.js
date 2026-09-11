/**
 * Browser half of `dsh-github-toolkit`: a **GitHub** section in Web Settings.
 *
 * It is a hand-written client bundle in the harness's lazy-CJS bundle format
 * (`window.__ModuleLoader__.load({ id, factory })`), so no build step is
 * involved: the host serves this exact file as the package's `./client` export.
 *
 * What the section does — the whole setup path without a terminal:
 * - reports whether the PAT is configured, where it comes from, and whether the
 *   credential store accepts writes (`ctx.remote.credentials.describe`);
 * - saves or clears the PAT through the credential store, so the value never
 *   enters `settings.yaml`, `cordis.patch.yml`, or a shell history;
 * - tests a pasted token live against `api.github.com` from the page (GitHub's
 *   REST API sends permissive CORS headers), showing login, scopes, and rate
 *   limit before anything is stored;
 * - edits the plugin's `tool-github` settings namespace (default repository,
 *   credential name, API base, timeout, page size, write mode) which the host
 *   plugin applies immediately.
 *
 * Only `react` and the shell's static UI primitives are required, so the bundle
 * stays independent of any feature package's internal API.
 *
 * @module dsh-github-toolkit/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-github-toolkit',
	factory: (require) => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
		const h = React.createElement

		/** Settings section id (drives the shell's `only` filtering). */
		const SECTION_ID = 'github'
		/** Settings namespace owned by this package's host half. */
		const SETTINGS_NAMESPACE = 'tool-github'
		/** Credential reference used when no override is stored. */
		const FALLBACK_TOKEN_REF = 'GITHUB_TOKEN'
		/** Fields the settings form owns; `恢复默认` clears exactly these. */
		const CONFIG_FIELDS = [
			'tokenRef',
			'apiBase',
			'defaultOwner',
			'defaultRepo',
			'timeoutMs',
			'perPage',
			'enableWrite',
		]
		const USER_AGENT = 'dsh-github-toolkit/0.1.0'
		const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

		/** Inline styling that reads correctly in both light and dark themes. */
		const styles = {
			root: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '2px 0 8px' },
			block: { display: 'flex', flexDirection: 'column', gap: '10px' },
			heading: { fontSize: '13px', fontWeight: 600, letterSpacing: '0.02em', opacity: 0.9 },
			hint: { fontSize: '12px', lineHeight: 1.6, opacity: 0.62, margin: 0 },
			row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
			grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' },
			field: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
			label: { fontSize: '12px', fontWeight: 500, opacity: 0.75 },
			input: {
				width: '100%',
				boxSizing: 'border-box',
				padding: '7px 9px',
				fontSize: '13px',
				fontFamily: 'inherit',
				color: 'inherit',
				background: 'rgba(127,127,127,0.06)',
				border: '1px solid rgba(127,127,127,0.32)',
				borderRadius: '6px',
				outline: 'none',
			},
			notice: { fontSize: '12px', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap' },
			ok: { color: '#3fb950' },
			error: { color: '#e5534b' },
			muted: { opacity: 0.62 },
			probe: {
				fontSize: '12px',
				lineHeight: 1.7,
				padding: '8px 10px',
				borderRadius: '6px',
				background: 'rgba(127,127,127,0.08)',
				border: '1px solid rgba(127,127,127,0.24)',
				whiteSpace: 'pre-wrap',
			},
		}

		/**
		 * Subscribe a component to a store whose snapshot is a plain object.
		 * @param {{getSnapshot: () => any, subscribe: (listener: () => void) => () => void}} store - Store.
		 * @returns {any} The current snapshot.
		 */
		function useStore(store) {
			const [snapshot, setSnapshot] = React.useState(store.getSnapshot)
			React.useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [store])
			return snapshot
		}

		/**
		 * Render one labelled text input.
		 * @param {object} options - Control definition.
		 * @param {string} options.label - Field label.
		 * @param {string} options.value - Current draft value.
		 * @param {(next: string) => void} options.onChange - Draft writer.
		 * @param {string} [options.placeholder] - Placeholder text.
		 * @param {string} [options.hint] - Help text under the input.
		 * @param {boolean} [options.disabled] - Disable the control.
		 * @param {boolean} [options.secret] - Render as a password field.
		 * @returns {any} React element.
		 */
		function TextField(options) {
			return h(
				'label',
				{ style: styles.field },
				h('span', { style: styles.label }, options.label),
				h('input', {
					type: options.secret === true ? 'password' : 'text',
					style: styles.input,
					value: options.value,
					placeholder: options.placeholder ?? '',
					disabled: options.disabled === true,
					spellCheck: false,
					autoComplete: 'off',
					onChange: (event) => options.onChange(event.target.value),
				}),
				options.hint === undefined ? null : h('span', { style: styles.hint }, options.hint),
			)
		}

		/**
		 * Build the store the section renders from: credential status, probe
		 * results, write actions, and the live settings snapshot.
		 * @param {any} ctx - Client plugin context.
		 * @param {any} scope - Bound `tool-github` settings scope.
		 * @returns {object} Store handle.
		 */
		function createStore(ctx, scope) {
			const listeners = new Set()
			let state = {
				scope: scope.getSnapshot(),
				ref: FALLBACK_TOKEN_REF,
				credential: undefined,
				credentialError: undefined,
				credentialLoading: true,
				busy: undefined,
				notice: undefined,
				probe: undefined,
			}

			const publish = () => {
				for (const listener of [...listeners]) listener()
			}
			const patch = (next) => {
				state = { ...state, ...next }
				publish()
			}
			const currentRef = (section) => {
				const name = section?.value?.tokenRef
				return typeof name === 'string' && name.trim() !== '' ? name.trim() : FALLBACK_TOKEN_REF
			}
			const message = (error) => (error instanceof Error ? error.message : String(error))

			/** Re-read the credential status for the configured reference. */
			async function refreshCredential() {
				const ref = currentRef(state.scope)
				try {
					const response = await ctx.remote.credentials.describe([ref])
					if (response.ok === true) {
						patch({
							ref,
							credential: response.value?.[ref],
							credentialError: undefined,
							credentialLoading: false,
						})
					} else {
						patch({
							ref,
							credential: undefined,
							credentialError: response.error?.message ?? '读取凭证失败',
							credentialLoading: false,
						})
					}
				} catch (error) {
					patch({ ref, credential: undefined, credentialError: message(error), credentialLoading: false })
				}
			}

			/** Store a PAT in the credential store. */
			async function saveToken(token) {
				const value = String(token ?? '').trim()
				if (value === '') {
					patch({ notice: { tone: 'error', text: '请先粘贴 GitHub 令牌。' } })
					return false
				}
				patch({ busy: 'save', notice: undefined })
				try {
					const response = await ctx.remote.credentials.set(currentRef(state.scope), value)
					if (response.ok !== true) throw new Error(response.error?.message ?? '写入凭证失败')
					patch({ busy: undefined, probe: undefined, notice: { tone: 'ok', text: `令牌已保存到 DSH 凭证 ${currentRef(state.scope)}。` } })
					await refreshCredential()
					return true
				} catch (error) {
					patch({ busy: undefined, notice: { tone: 'error', text: `保存失败：${message(error)}` } })
					return false
				}
			}

			/** Remove the stored PAT. */
			async function clearToken() {
				patch({ busy: 'clear', notice: undefined })
				try {
					const response = await ctx.remote.credentials.unset(currentRef(state.scope))
					if (response.ok !== true) throw new Error(response.error?.message ?? '删除凭证失败')
					patch({ busy: undefined, probe: undefined, notice: { tone: 'ok', text: '已清除存储的令牌（若启动环境变量仍在，它依然生效）。' } })
					await refreshCredential()
				} catch (error) {
					patch({ busy: undefined, notice: { tone: 'error', text: `清除失败：${message(error)}` } })
				}
			}

			/**
			 * Test a pasted token from the page. GitHub's REST API answers CORS
			 * preflights, so this needs no host round-trip and never reads back a
			 * stored secret.
			 */
			async function probeToken(token) {
				const value = String(token ?? '').trim()
				patch({ busy: 'probe', probe: undefined, notice: undefined })
				const base = String(state.scope.value?.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')
				try {
					const response = await fetch(`${base}/user`, {
						headers: {
							accept: 'application/vnd.github+json',
							'x-github-api-version': '2022-11-28',
							'user-agent': USER_AGENT,
							...(value === '' ? {} : { authorization: `Bearer ${value}` }),
						},
					})
					const text = await response.text()
					let payload
					try {
						payload = JSON.parse(text)
					} catch {
						payload = undefined
					}
					if (!response.ok) {
						patch({
							busy: undefined,
							probe: {
								ok: false,
								text: `GitHub 返回 ${response.status}：${payload?.message ?? text.slice(0, 200)}`,
							},
						})
						return
					}
					const scopes = response.headers.get('x-oauth-scopes')
					const remaining = response.headers.get('x-ratelimit-remaining')
					const limit = response.headers.get('x-ratelimit-limit')
					patch({
						busy: undefined,
						probe: {
							ok: true,
							text: [
								`令牌有效：@${payload?.login ?? '未知用户'}${payload?.name === undefined || payload.name === null ? '' : `（${payload.name}）`}`,
								`权限范围：${scopes === null || scopes === '' ? '未报告（细粒度 PAT 通常不返回）' : scopes}`,
								remaining === null || limit === null ? undefined : `剩余额度：${remaining}/${limit}`,
							].filter((line) => line !== undefined).join('\n'),
						},
					})
				} catch (error) {
					patch({ busy: undefined, probe: { ok: false, text: `无法连接 GitHub：${message(error)}` } })
				}
			}

			/**
			 * Commit the form: empty text clears the override, numbers are validated
			 * here because the settings section is the only writer.
			 * @param {object} draft - Form draft.
			 */
			async function saveConfig(draft) {
				patch({ busy: 'config', notice: undefined })
				try {
					const tokenRef = String(draft.tokenRef ?? '').trim()
					if (tokenRef !== '' && !CREDENTIAL_REF_PATTERN.test(tokenRef)) {
						throw new Error('凭证名必须是 POSIX 标识符，例如 GITHUB_TOKEN')
					}
					const timeoutMs = Number.parseInt(String(draft.timeoutMs ?? '').trim(), 10)
					if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('超时必须是正整数毫秒')
					const perPage = Number.parseInt(String(draft.perPage ?? '').trim(), 10)
					if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100) throw new Error('每页条数必须在 1-100 之间')

					const writeText = async (field, raw) => {
						const text = String(raw ?? '').trim()
						if (text === '') await scope.unset(field)
						else await scope.set(field, text)
					}
					await writeText('tokenRef', tokenRef)
					await writeText('apiBase', draft.apiBase)
					await writeText('defaultOwner', draft.defaultOwner)
					await writeText('defaultRepo', draft.defaultRepo)
					await scope.set('timeoutMs', timeoutMs)
					await scope.set('perPage', perPage)
					await scope.set('enableWrite', draft.enableWrite === true)

					patch({ busy: undefined, notice: { tone: 'ok', text: '配置已保存，立即生效。' } })
					await refreshCredential()
				} catch (error) {
					patch({ busy: undefined, notice: { tone: 'error', text: `保存失败：${message(error)}` } })
				}
			}

			/** Clear every override this section owns. */
			async function resetConfig() {
				patch({ busy: 'config', notice: undefined })
				try {
					for (const field of CONFIG_FIELDS) await scope.unset(field)
					patch({ busy: undefined, notice: { tone: 'ok', text: '已恢复默认配置。' } })
					await refreshCredential()
				} catch (error) {
					patch({ busy: undefined, notice: { tone: 'error', text: `恢复失败：${message(error)}` } })
				}
			}

			// Follow the settings scope for the plugin's lifetime: the shell owns
			// disposal, so the subscription is registered as a Cordis effect.
			const followScope = () => {
				const unsubscribe = scope.subscribe(() => {
					const next = scope.getSnapshot()
					const refChanged = currentRef(next) !== state.ref
					patch({ scope: next })
					if (refChanged) void refreshCredential()
				})
				void refreshCredential()
				return unsubscribe
			}
			if (typeof ctx.effect === 'function') ctx.effect(followScope, 'dsh-github-toolkit: settings scope')
			else followScope()

			return {
				getSnapshot: () => state,
				subscribe: (listener) => {
					listeners.add(listener)
					return () => listeners.delete(listener)
				},
				saveToken,
				clearToken,
				probeToken,
				saveConfig,
				resetConfig,
			}
		}

		/**
		 * The GitHub settings section.
		 * @param {object} props - Slot props: the injected store plus shell props.
		 * @returns {any} React element.
		 */
		function GitHubSection(props) {
			const store = props.api
			const snapshot = useStore(store)
			const [token, setToken] = React.useState('')
			const [draft, setDraft] = React.useState(undefined)

			const section = snapshot.scope
			const value = section?.value
			React.useEffect(() => {
				if (draft !== undefined || value === undefined) return
				setDraft({
					tokenRef: value.tokenRef ?? '',
					apiBase: value.apiBase ?? '',
					defaultOwner: value.defaultOwner ?? '',
					defaultRepo: value.defaultRepo ?? '',
					timeoutMs: String(value.timeoutMs ?? ''),
					perPage: String(value.perPage ?? ''),
					enableWrite: value.enableWrite !== false,
				})
			}, [draft, value])

			const Button = primitives.Button ?? ((buttonProps) => h('button', { type: 'button', ...buttonProps }))
			const Switch = primitives.Switch
			const Tag = primitives.Tag

			const busy = snapshot.busy
			const writable = section?.writable !== false
			const unavailable = section?.status === 'unavailable'
			const update = (field) => (next) => setDraft((previous) => ({ ...(previous ?? {}), [field]: next }))

			/** Credential status line. */
			const credentialText = snapshot.credentialLoading === true
				? '读取中…'
				: snapshot.credentialError !== undefined
					? `读取失败：${snapshot.credentialError}`
					: snapshot.credential?.configured === true
						? `已配置（来源：${snapshot.credential.source ?? '未知'}）`
						: '未配置'
			const credentialConfigured = snapshot.credential?.configured === true

			return h(
				'div',
				{ style: styles.root },

				// ── token ────────────────────────────────────────────────────────
				h(
					'div',
					{ style: styles.block },
					h('div', { style: styles.heading }, '访问令牌'),
					h(
						'div',
						{ style: styles.row },
						Tag === undefined
							? h('span', { style: styles.muted }, credentialText)
							: h(Tag, { tone: credentialConfigured ? 'neutral' : 'quiet' }, credentialText),
						h('span', { style: styles.hint }, `凭证引用：${snapshot.ref}`),
					),
					h('input', {
						type: 'password',
						style: styles.input,
						value: token,
						placeholder: '粘贴 PAT（ghp_… 或 github_pat_…），保存在 DSH 凭证库，不会回显',
						spellCheck: false,
						autoComplete: 'off',
						onChange: (event) => setToken(event.target.value),
					}),
					h(
						'div',
						{ style: styles.row },
						h(
							Button,
							{
								variant: 'outline',
								size: 'sm',
								disabled: busy !== undefined || token.trim() === '',
								onClick: () => void store.probeToken(token),
							},
							busy === 'probe' ? '测试中…' : '测试连接',
						),
						h(
							Button,
							{
								variant: 'primary',
								size: 'sm',
								disabled: busy !== undefined || !writable || token.trim() === '',
								onClick: async () => {
									if (await store.saveToken(token)) setToken('')
								},
							},
							busy === 'save' ? '保存中…' : '保存令牌',
						),
						h(
							Button,
							{
								variant: 'ghost',
								size: 'sm',
								disabled: busy !== undefined || !writable || !credentialConfigured,
								onClick: () => void store.clearToken(),
							},
							'清除',
						),
					),
					snapshot.probe === undefined
						? null
						: h('div', { style: { ...styles.probe, ...(snapshot.probe.ok === true ? styles.ok : styles.error) } }, snapshot.probe.text),
					h(
						'p',
						{ style: styles.hint },
						'「测试连接」在浏览器里用输入框中的令牌直接请求 api.github.com，因此可以在保存前确认账号、scope 与额度；'
						+ '已保存的令牌不会回显，状态行只报告是否已配置及其来源。',
					),
				),

				// ── configuration ────────────────────────────────────────────────
				h(
					'div',
					{ style: styles.block },
					h('div', { style: styles.heading }, '默认仓库与行为'),
					draft === undefined
						? h('p', { style: styles.hint }, unavailable ? '设置服务不可用（当前连接为内存模式），只能通过 composition 配置。' : '读取中…')
						: h(
							'div',
							{ style: styles.grid },
							h(TextField, {
								label: '默认 owner',
								value: draft.defaultOwner,
								placeholder: 'deepseek-ai',
								disabled: !writable,
								onChange: update('defaultOwner'),
								hint: '留空则要求模型每次显式给出',
							}),
							h(TextField, {
								label: '默认仓库',
								value: draft.defaultRepo,
								placeholder: 'deepseek-harness',
								disabled: !writable,
								onChange: update('defaultRepo'),
							}),
							h(TextField, {
								label: '凭证引用名',
								value: draft.tokenRef,
								placeholder: FALLBACK_TOKEN_REF,
								disabled: !writable,
								onChange: update('tokenRef'),
								hint: '令牌在该名字下的凭证库条目中读取',
							}),
							h(TextField, {
								label: 'API 地址',
								value: draft.apiBase,
								placeholder: 'https://api.github.com',
								disabled: !writable,
								onChange: update('apiBase'),
								hint: 'GitHub Enterprise Server 改这里',
							}),
							h(TextField, {
								label: '请求超时（毫秒）',
								value: draft.timeoutMs,
								placeholder: '30000',
								disabled: !writable,
								onChange: update('timeoutMs'),
							}),
							h(TextField, {
								label: '每页条数',
								value: draft.perPage,
								placeholder: '30',
								disabled: !writable,
								onChange: update('perPage'),
								hint: '1-100',
							}),
						),
					draft === undefined || Switch === undefined
						? null
						: h(
							'div',
							{ style: styles.row },
							h(Switch, {
								checked: draft.enableWrite === true,
								label: '允许写操作',
								disabled: !writable || busy !== undefined,
								// Accept both a boolean and a change event: the primitive's
								// callback shape is not part of the documented contract.
								onChange: (value) => update('enableWrite')(typeof value === 'boolean' ? value : value?.target?.checked === true),
							}),
							h(
								'span',
								{ style: styles.hint },
								draft.enableWrite === true
									? '模型可以建 issue、评论、提 PR、提交评审与文件'
									: '只保留只读工具，github_api 仅允许 GET',
							),
						),
					draft === undefined
						? null
						: h(
							'div',
							{ style: styles.row },
							h(
								Button,
								{
									variant: 'primary',
									size: 'sm',
									disabled: !writable || busy !== undefined,
									onClick: () => void store.saveConfig(draft),
								},
								busy === 'config' ? '保存中…' : '保存配置',
							),
							h(
								Button,
								{
									variant: 'ghost',
									size: 'sm',
									disabled: !writable || busy !== undefined,
									onClick: () => {
										setDraft(undefined)
										void store.resetConfig()
									},
								},
								'恢复默认',
							),
						),
				),

				// ── status ───────────────────────────────────────────────────────
				snapshot.notice === undefined
					? null
					: h('p', { style: { ...styles.notice, ...(snapshot.notice.tone === 'ok' ? styles.ok : styles.error) } }, snapshot.notice.text),
				h(
					'p',
					{ style: styles.hint },
					'保存后立刻生效：模型侧的 github_* 工具会按新配置工作，无需重启。'
					+ '可以直接对 DeepSeek 说「看一下 owner/repo 的开放 PR」，或让它先调用 github_auth_status 复核令牌。',
				),
			)
		}

		/** Cordis services this client plugin needs. */
		const inject = ['slots', 'remote', 'remote.credentials', 'settingsScope']

		/**
		 * Register the settings section.
		 * @param {any} ctx - Client plugin context.
		 */
		function apply(ctx) {
			const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
			const store = createStore(ctx, scope)

			ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: SECTION_ID,
				order: 40,
				label: () => 'GitHub',
				inject: () => ({ api: store }),
			}, GitHubSection))
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
