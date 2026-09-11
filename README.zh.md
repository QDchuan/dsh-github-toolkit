# dsh-github-toolkit

把 GitHub 接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：18 个模型可直接调用的 `github_*` 工具，**外加一个 Web 设置页** —— 粘贴 PAT、当场测试连接、指定默认仓库、开关写权限，全在 GUI 里完成，不需要终端，也不需要重启。

无构建步骤、无运行时依赖：宿主半边只用 Node 内置 `fetch`，浏览器半边只 require `react` 与 shell 的静态 UI 原语。

- **令牌不进配置**：从 DSH 凭证库按引用读取（默认 `GITHUB_TOKEN`），每次请求现取 —— 轮换令牌对下一次调用立即生效，`cordis.patch.yml` 里永远没有明文。
- **错误直接给出下一步**：401 → 换令牌；403 且额度为 0 → 何时重置；403 其他 → scope / SAML SSO；404 → 不存在或无权访问；422 → 带上 GitHub 的字段级明细。

## 环境要求

- DeepSeek Harness `0.1.5-rc.1` 或更新（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-credentials` 由 harness 以 peer 形式提供）。
- Node.js 22+（宿主半边用到 `AbortSignal.any`）。
- 一个 GitHub PAT，建议用细粒度令牌。

## 安装

```sh
dsh plugin --profile web add dsh-github-toolkit
```

包声明了 `dsh.bundle`，所以安装器会把它加进 profile 的 bundle 列表，`cordis.patch.yml` 里那一行负责挂载宿主半边。装完刷新 Web UI，打开 **设置 → GitHub**。

不走 npm 也可以：

```sh
dsh plugin --profile web add github:<owner>/dsh-github-toolkit
```

包里没有构建脚本，所以可以直接从仓库安装。

## 在 GUI 里配置

1. 刷新页面，打开 **设置 → GitHub**。
2. 粘贴 PAT → **测试连接**（页面直接请求 `api.github.com`，所以保存之前就能看到账号、scope、剩余额度）→ **保存令牌**。
3. 需要的话填「默认 owner / 默认仓库」，点 **保存配置**。

| 区块 | 能力 |
|---|---|
| 访问令牌 | 是否已配置、来源（凭证库 / 启动环境变量）、当前凭证引用名；密码框粘贴；测试连接；保存；清除 |
| 默认与行为 | 默认 owner、默认仓库、凭证引用名、API 地址（GitHub Enterprise Server）、请求超时、每页条数、**允许写操作**开关；保存配置；恢复默认 |

几个刻意的交互决定：

- **测试连接在浏览器里做**：GitHub REST API 允许跨域（`Access-Control-Allow-Origin: *`，并暴露 `X-OAuth-Scopes`、`X-RateLimit-*`），因此可以在把令牌交给宿主之前先验证它。
- **已保存的令牌不回显**：凭证库只回答「是否已配置 / 来源 / 可写」，页面拿不到值；想复核就重新粘贴一次点测试，或者让模型调用 `github_auth_status`。
- **保存即生效**：关掉写开关会注销写工具、把 `github_api` 收紧为仅 GET；打开则重新注册 —— 不用重启。
- **留空 = 恢复默认**：文本框清空后保存，等于清掉该项覆盖，回到 composition 默认值。

## 工具

| 工具 | 作用 | 只读 |
|---|---|---|
| `github_auth_status` | 令牌身份、scopes、剩余额度；凭证诊断入口 | ✅ |
| `github_get_repository` | 仓库元信息 | ✅ |
| `github_read_file` | 读文件（可指定 ref）或列目录 | ✅ |
| `github_search` | 搜索仓库 / 代码 / issue / commit / 用户 | ✅ |
| `github_list_issues` | 列 issue（状态、标签、负责人、时间过滤） | ✅ |
| `github_get_issue` | 单个 issue/PR 详情，可选评论 | ✅ |
| `github_list_pull_requests` | 列 PR | ✅ |
| `github_get_pull_request` | 单个 PR 详情 + 变更文件 + 可选完整 diff | ✅ |
| `github_list_commits` | 列 commit（可按路径/作者过滤） | ✅ |
| `github_list_branches` | 列分支 | ✅ |
| `github_get_checks` | ref 的 CI 状态与 check run | ✅ |
| `github_api` | 原始 REST 兜底（写开关关闭时仅允许 GET） | 视配置 |
| `github_create_issue` | 建 issue | ❌ |
| `github_comment` | 在 issue/PR 下评论 | ❌ |
| `github_update_issue` | 改标题/正文/状态/标签/负责人 | ❌ |
| `github_create_pull_request` | 建 PR | ❌ |
| `github_create_review` | 提交评审（可带行内评论） | ❌ |
| `github_write_file` | 通过 contents API 提交文件（自动取当前 sha） | ❌ |

只读与写入分开建模，便于用权限预设把写操作设为 `ask`；一个开关就能退成只读插件。

返回值**先裁剪再渲染**：GitHub 的原始对象远大于模型需要，正文 / patch / diff 都按配置截断并显式标注「已截断」。

## 配置

设置页写的是 `settings.yaml` 里的 `tool-github` 命名空间；composition 那一行只放默认值：

| 字段 | 默认 | 说明 |
|---|---|---|
| `tokenRef` | `GITHUB_TOKEN` | 凭证引用名 |
| `apiBase` | `https://api.github.com` | GitHub Enterprise Server 改这里 |
| `defaultOwner` / `defaultRepo` | — | 未配置时模型必须显式给出 owner/repo |
| `timeoutMs` | `30000` | 单请求超时 |
| `perPage` | `30` | 列表默认每页条数（上限 100） |
| `maxTextChars` | `6000` | 正文/普通响应截断长度 |
| `maxPatchChars` | `3000` | 单个文件 patch 截断长度 |
| `maxDiffChars` | `20000` | 完整 diff 截断长度 |
| `maxFileBytes` | `400000` | 超过则不返回文件内容，只给元信息 |
| `enableWrite` | `true` | 是否注册写操作工具 |
| `userAgent` | `dsh-github-toolkit/0.3.0` | 请求 UA |

## 凭证

PAT 存在 `$DSH_HOME/.credentials.yaml` 的 `refs` 段（设置页会写，也可以手工编辑）：

```yaml
refs:
  GITHUB_TOKEN: ghp_xxxxxxxx
```

查找优先级（由 `dsh-credentials-local` 决定）：**启动环境变量 > 凭证文件 > 项目 `.env` > `$DSH_HOME/.env`**。启动 dsh 前 shell 里已有的 `GITHUB_TOKEN` 会盖过凭证文件，设置页会如实显示来源。

PAT 建议权限（细粒度 PAT）：

- 只读：`Contents: read`、`Issues: read`、`Pull requests: read`、`Metadata: read`
- 写操作再加：`Contents: write`、`Issues: write`、`Pull requests: write`
- 读 CI：`Actions: read`、`Checks: read`
- 组织仓库若启用 SAML SSO，需要为令牌显式授权该组织，否则 API 返回 403

## 安全边界

- 令牌只经 `ctx.credentials` 每次现取，插件不缓存、不落盘、不打日志，也没有任何把令牌写进配置的代码路径。
- 测试连接把**输入框里的**值直接发给 `api.github.com`（不发给宿主），只存在于当前页面内存，保存成功后输入框立即清空。
- `github_api` 会绕过专用工具的字段校验，写开关关闭时可限制为 GET。
- 凭证库按文件权限保护，但 **agent 的工具进程以同一个 OS 用户运行，所以它读得到该文件** —— 这是「不主动告知路径」的克制，不是隔离。要真正隔离密钥，需要换一种存储方式。

## 开发

```sh
npm install          # 安装测试会 import 的 @deepseek-ai 依赖
npm test             # 宿主契约 + 浏览器 bundle（离线，另含一次真实网络 401 校验）
npm run test:installed
```

- `test/smoke.mjs` 不需要 PAT：它按加载器的方式驱动插件，用极简 React 运行器真实渲染设置分页，并用桩响应断言错误映射；有网络时还会用无效令牌验证真实的 401 映射，离线自动跳过。
- `test/installed.mjs` 校验运行时实际加载的那份：`node test/installed.mjs [profile] [pluginDir]`。

本地开发可以直接把 profile 指向这个目录，而不必发布：

```powershell
./install.ps1 -DryRun     # 只打印将要复制与写入的内容
./install.ps1             # 复制进 web profile 并写入一段手工 patch 行
./install.ps1 -Uninstall  # 删除副本与那段 patch 行
```

不要和 `dsh plugin add` 的安装方式同时使用：两者解析到同一个包，而同一个包有两个活跃 Loader 来源是组合错误。

## 文件

| 文件 | 角色 |
|---|---|
| `cordis.patch.yml` | bundle 层：挂载宿主半边的那一行 |
| `lib/index.js` | 宿主半边与包根：配置、凭证解析、工具注册、settings 命名空间 |
| `lib/client.js` | 浏览器半边：设置 → GitHub 分页（手写客户端 bundle，无构建） |
| `lib/rest.js` | GitHub REST 客户端：超时、分页、错误映射 |
| `lib/tools-read.js` / `lib/tools-write.js` | 只读 / 写入工具定义 |
| `lib/format.js` / `lib/shared.js` | 返回值裁剪与渲染；参数与分页 helper |
| `test/smoke.mjs` / `test/installed.mjs` | 契约测试 / 安装副本校验 |

## 已知限制

- 工具覆盖本插件建模过的 REST 面；其他接口走 `github_api`，它返回有界的 JSON 而不是类型化结果。
- GitHub 搜索的 `total_count` 在结果集很大时是近似值，插件原样透出。
- 浏览器半边是手写客户端 bundle，控件是自绘的而非 schema 驱动表单；新增选项要同时改 `lib/client.js` 与 `lib/index.js`。
- 已经加载过客户端 bundle 的 profile 需要刷新页面才能拿到新版本。

## 许可

MIT
