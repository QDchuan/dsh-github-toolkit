# dsh-github-toolkit

[English](README.md) | **中文**

把 GitHub 接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：**18 个模型可直接调用的 `github_*` 工具**，外加一个 **Web 设置页** —— 粘贴 PAT、当场测试连接、指定默认仓库、开关写权限，全在 GUI 里完成，不需要终端，也不需要重启。

无构建步骤、无运行时依赖：宿主半边只用 Node 内置 `fetch`，浏览器半边只 require `react` 与 shell 的静态 UI 原语。

- **令牌不进配置**：从 DSH 凭证库按引用读取（默认 `GITHUB_TOKEN`），每次请求现取 —— 轮换令牌对下一次调用立即生效，`cordis.patch.yml` 与 `settings.yaml` 里永远没有明文密钥。
- **配置即改即生效**：设置页保存后宿主立刻按新配置工作（关掉写权限会直接注销写工具），不用重启。
- **错误直接给出下一步**：401 → 换令牌；403 且额度为 0 → 何时重置；403 其他 → scope / SAML SSO；404 → 不存在或无权访问；422 → 带上 GitHub 的字段级明细。
- **返回值先裁剪再给模型**：正文 / patch / diff 都按预算截断并标注「已截断」，避免把 GitHub 的原始大对象灌进上下文。

## 环境要求

- DeepSeek Harness `0.1.5-rc.1` 或更新（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-credentials` 由 harness 以 peerDependencies 形式提供）。
- Node.js 22+（宿主半边用到 `AbortSignal.any`）。
- 一个 GitHub PAT。**建议用 classic token（勾 `repo`）**：细粒度令牌默认没有「创建仓库」这类权限，容易在后续操作上卡住（详见下方排错）。

## 快速上手（3 步）

```sh
# 1) 安装
dsh plugin --profile web add dsh-github-toolkit
```

2. **刷新** http://127.0.0.1:3080 ，打开 **设置 → GitHub**
3. 粘贴 PAT → 点 **测试连接**（页面会显示 `@你的账号`、`权限范围`、`剩余额度`）→ 点 **保存令牌**

然后就能直接对话了，例如：

- 「看一下 owner/repo 的开放 issue，按标签分个类」
- 「把这个报错整理成 issue 提上去，标题用 xxx」
- 「PR #42 改了什么？CI 过了吗？值得合并吗？」
- 「在 src 目录里搜一下 `TODO(` ，列出来」
- 「把 `docs/readme.md` 的第 12 行改掉，提交到 `chore/fix-typo` 分支并开 PR」

## 安装

包声明了 `dsh.bundle`，所以安装器会把它加进 profile 的 `dsh.profile.bundles`，bundle 里的 `cordis.patch.yml` 负责挂载宿主半边；浏览器半边通过 `package.json` 的 `dsh.client` 自动出现，不需要额外注册。

```sh
# npm 名（发布到 npm 时）
dsh plugin --profile web add dsh-github-toolkit

# 直接从仓库装（推荐，当前即如此）
dsh plugin --profile web add github:QDchuan/dsh-github-toolkit
```

包里**没有构建脚本**，所以从 git 安装不需要 `allowBuilds` 授权，几秒装完。

本地开发（不想发布、只想让 profile 指向当前目录）：

```powershell
./install.ps1 -DryRun     # 只打印将要复制与写入的内容
./install.ps1             # 复制进 web profile 并写入一段手工 patch 行
./install.ps1 -Uninstall  # 删除副本与那段 patch 行
```

> ⚠️ **不要和 `dsh plugin add` 的安装方式同时使用**：两者解析到同一个包，而同一个包有两个活跃 Loader 来源会直接组合报错。要从本地开发切到已发布版本，先 `.\install.ps1 -Uninstall`。

## GUI 设置页

| 区块 | 能力 |
|---|---|
| 访问令牌 | 是否已配置、来源（凭证库 / 启动环境变量）、当前凭证引用名；密码框粘贴；**测试连接**；**保存令牌**；**清除** |
| 默认与行为 | 默认 owner、默认仓库、凭证引用名、API 地址（GitHub Enterprise Server）、请求超时、每页条数、**允许写操作**开关；**保存配置**；**恢复默认** |

几个刻意的交互决定：

- **测试连接在浏览器里做**：GitHub REST API 允许跨域（`Access-Control-Allow-Origin: *`，并暴露 `X-OAuth-Scopes`、`X-RateLimit-*`），所以在令牌交给宿主之前就能先验证它，测试结果会显示账号、scope、剩余额度。
- **已保存的令牌不回显**：凭证库只回答「是否已配置 / 来源 / 可写」，页面拿不到值；想复核就重新粘贴一次点测试，或让模型调用 `github_auth_status`。
- **保存即生效**：关掉写开关会注销 6 个写工具、把 `github_api` 收紧为仅 GET；打开则重新注册 —— 不用重启。
- **留空 = 恢复默认**：文本框清空后保存，等于清掉该项覆盖，回到 composition 默认值（例如默认 owner 留空后，模型必须每次显式给出 owner/repo）。
- **写操作与只读分开建模**：便于用权限预设把写工具设为 `ask`；一个开关就能整体退成只读插件。

## 工具

| 工具 | 作用 | 只读 |
|---|---|---|
| `github_auth_status` | 令牌身份、scopes、剩余额度；凭证诊断入口 | ✅ |
| `github_get_repository` | 仓库元信息 | ✅ |
| `github_read_file` | 读文件（可指定分支/tag/commit）或列目录 | ✅ |
| `github_search` | 搜索仓库 / 代码 / issue / commit / 用户 | ✅ |
| `github_list_issues` | 列 issue（状态、标签、负责人、时间过滤） | ✅ |
| `github_get_issue` | 单个 issue/PR 详情，可选评论 | ✅ |
| `github_list_pull_requests` | 列 PR（状态、head/base 过滤、排序） | ✅ |
| `github_get_pull_request` | 单个 PR 详情 + 变更文件 + 可选完整 diff | ✅ |
| `github_list_commits` | 列 commit（可按路径/作者过滤） | ✅ |
| `github_list_branches` | 列分支 | ✅ |
| `github_get_checks` | ref 的 CI 状态与 check run | ✅ |
| `github_api` | 原始 REST 兜底（写开关关闭时仅允许 GET） | 视配置 |
| `github_create_issue` | 建 issue | ❌ |
| `github_comment` | 在 issue/PR 下评论 | ❌ |
| `github_update_issue` | 改标题 / 正文 / 状态 / 标签 / 负责人 | ❌ |
| `github_create_pull_request` | 建 PR（支持跨仓库 `owner:branch`） | ❌ |
| `github_create_review` | 提交评审，可带行内评论 | ❌ |
| `github_write_file` | 通过 contents API 提交文件（自动取当前 sha） | ❌ |

## 配置

设置页写的是 `settings.yaml` 里的 `tool-github` 命名空间；composition 那一行只放默认值：

| 字段 | 默认 | 说明 |
|---|---|---|
| `tokenRef` | `GITHUB_TOKEN` | 凭证引用名 |
| `apiBase` | `https://api.github.com` | GitHub Enterprise Server 改这里 |
| `defaultOwner` / `defaultRepo` | — | 未配置时模型必须显式给出 owner/repo |
| `timeoutMs` | `30000` | 单请求超时（毫秒） |
| `perPage` | `30` | 列表默认每页条数（上限 100） |
| `maxTextChars` | `6000` | 正文/普通响应截断长度 |
| `maxPatchChars` | `3000` | 单个文件 patch 截断长度 |
| `maxDiffChars` | `20000` | 完整 diff 截断长度 |
| `maxFileBytes` | `400000` | 超过则不返回文件内容，只给元信息 |
| `enableWrite` | `true` | 是否注册写操作工具 |
| `userAgent` | `dsh-github-toolkit/0.3.0` | 请求 UA |

## 凭证与权限

PAT 存在 `$DSH_HOME/.credentials.yaml` 的 `refs` 段（设置页会写，也可以手工编辑）：

```yaml
refs:
  GITHUB_TOKEN: ghp_xxxxxxxx
```

查找优先级（由 `dsh-credentials-local` 决定）：**启动环境变量 > 凭证文件 > 项目 `.env` > `$DSH_HOME/.env`**。启动 dsh 前 shell 里已经存在的 `GITHUB_TOKEN` 会盖过凭证文件，设置页会如实显示来源。

### 令牌怎么选

| | classic token（`ghp_`） | 细粒度令牌（`github_pat_`） |
|---|---|---|
| 建仓库 / 部分管理类 API | ✅ 勾 `repo` 即可 | ❌ 常因缺少 `Administration` 权限被拒 |
| 最小权限 | 偏大（`repo` 覆盖全仓读写） | ✅ 可按仓库、按权限细分 |
| 是否报告 scopes | ✅ 连接测试会显示 `权限范围: repo` | ❌ 不返回该响应头（显示「未报告 scopes」属正常） |

**只做读写代码/issue/PR 的话**，细粒度令牌按下面勾就够：`Contents: read/write`、`Issues: read/write`、`Pull requests: read/write`、`Metadata: read`，读 CI 再加 `Actions: read`、`Checks: read`；组织仓库若启用 SAML SSO，需要为令牌显式授权该组织，否则 API 返回 403。

**如果你希望 DeepSeek 顺手帮你建仓库、设 topics**，用 classic token 勾 `repo` 最省事。

## 排错

| 现象 | 原因与处理 |
|---|---|
| 连接测试显示 `401` | 令牌本身无效：复制不全、已过期/被删、或粘贴的是 App secret。重新生成一个再试 |
| 报错「未找到 GitHub 令牌」 | 凭证、`.env`、进程环境都没有值。到 **设置 → GitHub** 粘贴保存，或用 `GITHUB_TOKEN=... ` 启动 dsh |
| 能读但不能写 / 建仓库 `403 Resource not accessible by personal access token` | 令牌权限不足（细粒度令牌尤其常见）。给对应权限，或换 classic token |
| `403` 且提示速率受限 | 额度用尽，页面会给出重置时间；等待或换额度更高的令牌 |
| `403` 其他 | 通常是缺 scope，或组织启用了 SAML SSO 而令牌未授权该组织 |
| `404` | 资源不存在，**或**当前令牌无权访问私有资源（私有仓库需要 `repo` / `Contents: read`） |
| `422` | 参数被 GitHub 拒绝：分支不存在、head/base 同名、标签或负责人不是协作者等，报错里会带字段级明细 |
| 设置里**没有 GitHub 分页** | 先刷新页面。仍然没有，说明运行中的宿主还没把新的客户端插件图发布出来（实测出现过），重启一次 dsh 即可 |
| 保存了令牌但没生效 | 检查启动 dsh 的 shell 里是否已有 `GITHUB_TOKEN`（它会盖过凭证文件，页面「来源」一栏会显示是哪种）；或点「测试连接」确认值本身有效 |
| 装成了**别人的**插件 | npm 上的 `dsh-tool-github` 是另一个项目，本插件的包名是 **`dsh-github-toolkit`** |
| `git` 走 HTTPS 报 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` | Windows Schannel 后端在该环境下取不到凭据（沙箱/受限环境常见）。`git config --global http.sslBackend openssl` 切到 OpenSSL 后端即可（Node/pnpm 本身不受影响） |

## 安全边界

- 令牌只经 `ctx.credentials` 每次现取，插件**不缓存、不落盘、不打日志**，也没有任何把令牌写进配置的代码路径。
- 「测试连接」把**输入框里的**值直接发给 `api.github.com`（不发给宿主），只存在于当前页面内存；保存成功后输入框立即清空。
- `github_api` 会绕过专用工具的字段校验，写开关关闭时可限制为 GET。
- 凭证库按文件权限保护，但 **agent 的工具进程以同一个 OS 用户运行，所以它读得到该文件** —— 这是「不主动告知路径」的克制，不是隔离。要真正隔离密钥，需要换一种存储方式。

## 开发

```sh
npm install          # 安装测试会 import 的 @deepseek-ai 依赖
npm test             # 宿主契约 + 浏览器 bundle（离线，另含一次真实网络 401 校验）
npm run test:installed
```

- `test/smoke.mjs` 不需要 PAT：它按加载器的方式驱动宿主半边，用极简 React 运行器真实渲染设置分页并跑一遍保存/测试/配置写入，再用桩响应断言错误映射；有网络时还会用无效令牌验证真实的 401 映射，离线自动跳过。里面固定了几条容易回归的约束，例如「工具返回值必须是无损 JSON」。
- `test/installed.mjs` 校验运行时实际加载的那份：文件、清单（含 `dsh.bundle`）、profile 的 patch 行、宿主导入、浏览器 bundle 只依赖基线模块。用法：`node test/installed.mjs [profile] [pluginDir]`。

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
