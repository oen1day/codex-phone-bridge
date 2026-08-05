$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# 运行 gh 命令并返回退出码（不让普通报错中断脚本）
function Invoke-Gh {
  param([string[]]$GhArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & gh @GhArgs 2>&1 | Out-Null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  return $code
}

# 从 git 配置推断 GitHub 用户名
$email = git config --global user.email
$user = ''
if ($email -match '^\d+\+([^@]+)@') { $user = $Matches[1] }
if (-not $user) {
  $user = Read-Host '请输入你的 GitHub 用户名'
}
$repo = 'codex-phone-bridge'
$vjLocal = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'version.json') | ConvertFrom-Json
$version = $vjLocal.version
$tag = 'v' + $version

# 检查 GitHub CLI
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Host ''
  Write-Host '还没安装 GitHub CLI，请先执行：' -ForegroundColor Yellow
  Write-Host '  winget install --id GitHub.cli' -ForegroundColor Cyan
  Write-Host '安装后请新开一个 PowerShell 窗口，再运行 gh auth login。' -ForegroundColor Yellow
  Read-Host '按回车退出'
  exit 1
}

# 检查是否已登录
if ((Invoke-Gh @('auth', 'status')) -ne 0) {
  Write-Host 'GitHub 还没登录，请先运行 gh auth login 登录（新开一个 PowerShell 窗口运行）。' -ForegroundColor Yellow
  Read-Host '按回车退出'
  exit 1
}

# 创建公开仓库（如果不存在）
if ((Invoke-Gh @('repo', 'view', "$user/$repo")) -ne 0) {
  Write-Host "创建公开仓库 $user/$repo ..."
  if ((Invoke-Gh @('repo', 'create', "$user/$repo", '--public', '--description', 'Codex 手机遥控更新源')) -ne 0) {
    throw '创建仓库失败'
  }
}

# 获取仓库默认分支（main 或 master）
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$branchOut = & gh repo view "$user/$repo" --json defaultBranchRef --jq '.defaultBranchRef.name' 2>$null
$ErrorActionPreference = $prev
$branch = ($branchOut | Select-Object -First 1)
if (-not $branch) { $branch = 'main' }
$branch = $branch.Trim()

$updateUrl = "https://raw.githubusercontent.com/$user/$repo/$branch/version.json"

# 先把电脑端 config.json 的更新地址写好
$cfgPath = Join-Path $root 'config.json'
$cfg = Get-Content -Raw -Encoding UTF8 $cfgPath | ConvertFrom-Json
if ($null -eq $cfg.PSObject.Properties['updateUrl']) {
  $cfg | Add-Member -NotePropertyName updateUrl -NotePropertyValue $updateUrl -Force
} else {
  $cfg.updateUrl = $updateUrl
}
$newJson = $cfg | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($cfgPath, $newJson, (New-Object System.Text.UTF8Encoding $false))

# 生成电脑端压缩包（包含手机 APK 和发布脚本）
function New-ReleaseZip {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $tmp = Join-Path $env:TEMP ('codexbridge-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $items = @(
    'server.js', 'start.bat', 'start.ps1', 'build-apk.ps1',
    'README.md', 'version.json', 'publish-update.ps1', 'public', 'android',
    'CodexPhoneBridge.apk', 'phone-mcp.js', 'phone-tool.ps1', 'config.example.json'
  )
  foreach ($i in $items) {
    Copy-Item -LiteralPath (Join-Path $root $i) -Destination $tmp -Recurse -Force
  }
  $ksJunk = Join-Path $tmp 'android\debug.keystore'
  if (Test-Path $ksJunk) { Remove-Item -LiteralPath $ksJunk -Force }
  $buildJunk = Join-Path $tmp 'android\build'
  if (Test-Path $buildJunk) { Remove-Item -LiteralPath $buildJunk -Recurse -Force }
  $wwwJunk = Join-Path $tmp 'android\assets\www'
  if (Test-Path $wwwJunk) { Remove-Item -LiteralPath $wwwJunk -Recurse -Force }
  $outZip = Join-Path $root 'CodexPhoneBridge-PC.zip'
  if (Test-Path $outZip) { Remove-Item -LiteralPath $outZip -Force }
  $zip = [System.IO.Compression.ZipFile]::Open($outZip, [System.IO.Compression.ZipArchiveMode]::Create)
  $files = Get-ChildItem -LiteralPath $tmp -Recurse -File
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($tmp.Length).TrimStart('\', '/').Replace('\', '/')
    $entry = $zip.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
    $in = $f.OpenRead()
    $out = $entry.Open()
    $in.CopyTo($out)
    $out.Dispose()
    $in.Dispose()
  }
  $zip.Dispose()
  Remove-Item -LiteralPath $tmp -Recurse -Force
}

Write-Host '生成电脑端压缩包 ...'
New-ReleaseZip

# 生成 version.json 内容并上传
$zipUrl = "https://github.com/$user/$repo/releases/download/$tag/CodexPhoneBridge-PC.zip"
$apkUrl = "https://github.com/$user/$repo/releases/download/$tag/CodexPhoneBridge.apk"
$vj = @{
  version = $version
  pcZip   = $zipUrl
  apk     = $apkUrl
} | ConvertTo-Json
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($vj))

Write-Host '上传 version.json ...'
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$shaOut = & gh api "repos/$user/$repo/contents/version.json" --jq '.sha' 2>$null
$ErrorActionPreference = $prev
$sha = ($shaOut | Select-Object -First 1)
if ($sha) { $sha = $sha.Trim() }

$putArgs = @('api', '-X', 'PUT', "repos/$user/$repo/contents/version.json", '-f', 'message=update version.json', '-f', "content=$b64")
if ($sha) { $putArgs += @('-f', "sha=$sha") }
if ((Invoke-Gh @($putArgs)) -ne 0) {
  throw '上传 version.json 失败'
}

# 发布 Release 并上传两个安装包
Write-Host '发布 Release ...'
$zipFile = Join-Path $root 'CodexPhoneBridge-PC.zip'
$apkFile = Join-Path $root 'CodexPhoneBridge.apk'
if (-not (Test-Path $zipFile)) { throw '生成压缩包失败' }
if (-not (Test-Path $apkFile)) { throw '找不到 CodexPhoneBridge.apk' }
if ((Invoke-Gh @('release', 'create', $tag, $zipFile, $apkFile, '--repo', "$user/$repo", '--title', $tag, '--notes', "Codex 手机遥控 v$version")) -ne 0) {
  Write-Host "Release $tag 已存在，尝试覆盖上传新文件 ..."
  if ((Invoke-Gh @('release', 'upload', $tag, $zipFile, $apkFile, '--repo', "$user/$repo", '--clobber')) -ne 0) {
    throw "发布/覆盖 Release 失败：请到网页删除 $tag 后重试"
  }
}

Write-Host ''
Write-Host '全部完成！' -ForegroundColor Green
Write-Host '电脑端更新地址（已自动写入 config.json）：' -ForegroundColor Cyan
Write-Host "  $updateUrl" -ForegroundColor Green
Write-Host '手机 App：设置 -> 更新地址 填上面这个网址，然后点「检查更新」。' -ForegroundColor Cyan
Write-Host ''
