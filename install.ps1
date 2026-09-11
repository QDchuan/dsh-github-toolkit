<#
.SYNOPSIS
  Local development installer: mount this checkout in a dsh profile.

.DESCRIPTION
  Normally you install the published plugin and never touch this script:

      dsh plugin --profile web add github:<owner>/dsh-github-toolkit

  That path uses the package's `dsh.bundle` manifest, so the package manager
  installs it into the profile's node_modules and the loader picks up its patch
  layer automatically. This script exists for the case where you want to run
  whatever is in this folder right now: it copies the plugin to
  <DSH_HOME>/profiles/<Profile>/plugins/<name> and writes one manual patch row
  pointing at the copy, between `# >>> <name>` markers (so re-running updates it
  in place and -Uninstall removes exactly what it added).

  Do not use both at once: a bundle install and this manual row resolve to the
  same package, and two active Loader sources for one package are a composition
  error. Uninstall this one first with -Uninstall.

  The optional PAT handling writes the token into the DSH credential store
  (<DSH_HOME>/.credentials.yaml, `refs:` section) — the plugin reads it from
  there by reference, so the secret never lands in cordis.patch.yml or a shell
  history. Without -Token or -TokenPrompt the script leaves credentials alone;
  the Web settings page is the friendlier way to store it.

.EXAMPLE
  ./install.ps1
  Copy this checkout into the web profile with defaults (credential ref GITHUB_TOKEN).

.EXAMPLE
  ./install.ps1 -DryRun
  Show what would be copied and written without touching anything.

.EXAMPLE
  ./install.ps1 -Uninstall
  Remove the copied plugin and its patch row.
#>
[CmdletBinding()]
param(
  # dsh profile to install into.
  [string]$Profile = 'web',

  # Credential reference (environment-variable name) the plugin resolves.
  [string]$TokenEnv = 'GITHUB_TOKEN',

  # PAT value; passed directly, so prefer -TokenPrompt on a shared machine.
  [string]$Token,

  # Read the PAT from a non-echoing prompt.
  [switch]$TokenPrompt,

  # Default repository owner for tools that omit `owner` (also editable in the Web settings page).
  [string]$DefaultOwner,

  # Default repository name for tools that omit `repo` (also editable in the Web settings page).
  [string]$DefaultRepo,

  # Write `enableWrite: false` into the row; omit to keep the default (writes enabled).
  [switch]$ReadOnly,

  # Per-request timeout in milliseconds; omit to keep the default (30000).
  [int]$TimeoutMs = 0,

  # Remove the plugin, its patch row, and nothing else.
  [switch]$Uninstall,

  # Show what would change without writing anything.
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Utf8NoBom {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Content)
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8)
}

function Get-DshHome {
  if ($env:DSH_HOME) { return $env:DSH_HOME }
  return (Join-Path $env:USERPROFILE '.dsh')
}

$sourceDir = $PSScriptRoot
$pluginName = Split-Path $sourceDir -Leaf
$dshHome = Get-DshHome
$profileDir = Join-Path $dshHome (Join-Path 'profiles' $Profile)
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$targetDir = Join-Path $profileDir "plugins\$pluginName"
# Removed on install so a rename cannot leave two copies of the same package.
$legacyDir = Join-Path $profileDir 'plugins\dsh-tool-github'
$credentialPath = Join-Path $dshHome '.credentials.yaml'
$rowId = 'tool-github'
$beginMarker = "# >>> $pluginName (managed by install.ps1) >>>"
$endMarker = "# <<< $pluginName <<<"

if (-not (Test-Path $profileDir)) {
  throw "找不到 profile 目录：$profileDir（先用 dsh --profile $Profile 启动一次以初始化）"
}

function Remove-ManagedBlock {
  <#
    Strip every block this script owns, whatever plugin name is inside it: a
    renamed checkout leaves a block whose markers name the old plugin, and two
    rows for one id would both be applied.
  #>
  param([string]$Text)

  $pattern = '(?ms)^[ \t]*# >>> .*? \(managed by install\.ps1\) >>>\r?\n.*?^[ \t]*# <<< .*? <<<[ \t]*\r?\n?'
  return [regex]::Replace($Text, $pattern, '')
}

function Read-PatchText {
  if (Test-Path $patchPath) { return (Get-Content $patchPath -Raw) }
  return "# Your patch layer for this dsh profile.`n[]`n"
}

<#
.SYNOPSIS
  Compose the managed patch row.
.DESCRIPTION
  Only what the caller asked for is written: the composition entry is a set of
  defaults, and everything else is owned by the Web settings page (which writes
  the `tool-github` settings namespace). Emitting just `tokenRef` keeps the row
  and the settings document from disagreeing about the same value.
#>
function New-PatchBlock {
  $lines = @()
  $lines += $beginMarker
  $lines += '- insert:'
  $lines += "    - id: $rowId"
  $lines += "      name: './plugins/$pluginName/lib/index.js'"
  $lines += '      config:'
  $lines += "        tokenRef: $TokenEnv"
  if ($TimeoutMs -gt 0) { $lines += "        timeoutMs: $TimeoutMs" }
  if ($ReadOnly) { $lines += '        enableWrite: false' }
  if ($DefaultOwner) { $lines += "        defaultOwner: $DefaultOwner" }
  if ($DefaultRepo) { $lines += "        defaultRepo: $DefaultRepo" }
  $lines += $endMarker
  return ($lines -join "`n") + "`n"
}

function Set-CredentialRef {
  param([string]$Name, [string]$Value)

  if (Test-Path $credentialPath) {
    $text = Get-Content $credentialPath -Raw
  } else {
    $text = "version: 1`n`nrefs:`n`nrecords:`n"
  }
  $quoted = '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
  $entry = "  ${Name}: $quoted"
  $existingEntry = [regex]::Match($text, "(?m)^[ \t]+$([regex]::Escape($Name))[ \t]*:.*$")

  if ($existingEntry.Success) {
    $text = $text.Remove($existingEntry.Index, $existingEntry.Length).Insert($existingEntry.Index, $entry)
  } elseif ([regex]::IsMatch($text, '(?m)^refs[ \t]*:[ \t]*$')) {
    $text = [regex]::Replace($text, '(?m)^(refs[ \t]*:[ \t]*)$', "`$1`n$entry", 1)
  } else {
    $text = $text.TrimEnd() + "`n`nrefs:`n$entry`n"
  }

  if ($DryRun) {
    Write-Host "[dry-run] 将写入凭证引用 $Name 到 $credentialPath"
    return
  }
  Write-Utf8NoBom -Path $credentialPath -Content $text
  Write-Host "已写入凭证引用 $Name 到 $credentialPath"
}

if ($Uninstall) {
  $text = Remove-ManagedBlock (Read-PatchText)
  if (-not [regex]::IsMatch($text, '(?m)^\s*-\s')) {
    $text = [regex]::Replace($text, '(?m)^\s*\[\s*\]\s*$', '[]')
    if (-not [regex]::IsMatch($text, '(?m)^\s*\[\s*\]\s*$')) { $text = $text.TrimEnd() + "`n[]`n" }
  }
  if ($DryRun) {
    Write-Host "[dry-run] 将删除 $targetDir 并清理 $patchPath 中的 patch 行"
  } else {
    if (Test-Path $targetDir) { Remove-Item -Recurse -Force $targetDir }
    Write-Utf8NoBom -Path $patchPath -Content $text
    Write-Host "已卸载 dsh-github-toolkit（profile: $Profile）"
    Write-Host '重启 dsh 或刷新页面后生效。'
  }
  return
}

# ── install ─────────────────────────────────────────────────────────────────
foreach ($required in 'lib\index.js', 'lib\client.js', 'lib\rest.js', 'cordis.patch.yml', 'package.json') {
  if (-not (Test-Path (Join-Path $sourceDir $required))) { throw "源目录不完整：$sourceDir\$required 不存在" }
}

$patchText = Remove-ManagedBlock (Read-PatchText)
$block = New-PatchBlock
if ([regex]::IsMatch($patchText, '(?m)^\s*\[\s*\]\s*$')) {
  $patchText = [regex]::Replace($patchText, '(?m)^\s*\[\s*\]\s*$', $block.TrimEnd())
} else {
  $patchText = $patchText.TrimEnd() + "`n" + $block
}

if ($DryRun) {
  Write-Host "[dry-run] 将复制插件到 $targetDir"
  Write-Host "[dry-run] 将写入 $patchPath ："
  Write-Host $block
} else {
  New-Item -ItemType Directory -Force -Path (Join-Path $targetDir 'lib') | Out-Null
  Copy-Item (Join-Path $sourceDir 'package.json') $targetDir -Force
  Copy-Item (Join-Path $sourceDir 'cordis.patch.yml') $targetDir -Force
  foreach ($doc in 'README.md', 'README.zh.md', 'LICENSE') {
    if (Test-Path (Join-Path $sourceDir $doc)) { Copy-Item (Join-Path $sourceDir $doc) $targetDir -Force }
  }
  Copy-Item (Join-Path $sourceDir 'lib\*.js') (Join-Path $targetDir 'lib') -Force
  Write-Utf8NoBom -Path $patchPath -Content $patchText
  # A renamed checkout must not leave the previous copy behind: two packages
  # resolving to one browser module is a composition error.
  if ((Test-Path $legacyDir) -and ($legacyDir -ne $targetDir)) {
    Remove-Item -Recurse -Force $legacyDir
    Write-Host "已清理旧位置的副本：$legacyDir"
  }

  $version = (Get-Content (Join-Path $sourceDir 'package.json') -Raw | ConvertFrom-Json).version
  Write-Host "已安装 $pluginName v$version"
  Write-Host "  插件：$targetDir"
  Write-Host "  patch：$patchPath"
}

# ── optional credential ─────────────────────────────────────────────────────
$secret = $Token
if (-not $secret -and $TokenPrompt) {
  $secure = Read-Host -Prompt "粘贴 GitHub PAT（输入不回显）" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if ($secret) {
  Set-CredentialRef -Name $TokenEnv -Value $secret.Trim()
} else {
  Write-Host "未提供 PAT：推荐直接在 Web 界面「设置 → GitHub」里粘贴并保存（不回显、可当场测试连接）。"
  Write-Host "  也可以用命令行写入 $credentialPath 的 refs 段（${TokenEnv}: ghp_...），或用环境变量 $TokenEnv 启动 dsh。"
}

if (-not $DryRun) {
  Write-Host ''
  Write-Host '下一步（全部在 GUI 里完成）：'
  Write-Host "  1) 刷新 http://127.0.0.1:3080 —— 设置里会出现 GitHub 分页"
  Write-Host '  2) 粘贴 PAT → 测试连接 → 保存令牌'
  Write-Host '  3) 需要的话填「默认 owner / 默认仓库」并保存配置（立即生效，无需重启）'
}
