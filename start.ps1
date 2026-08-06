# 不使用全局 ErrorActionPreference=Stop：避免 node 的 stderr 把整个脚本打断
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-LatestFile($pattern) {
  $items = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue
  if ($items) {
    return ($items | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
  }
  return $null
}

$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
if (-not $node) {
  $node = Find-LatestFile "$env:LOCALAPPDATA\OpenAI\Codex\runtimes\cua_node\*\bin\node.exe"
}

$codex = $null
$cmd2 = Get-Command codex -ErrorAction SilentlyContinue
if ($cmd2) { $codex = $cmd2.Source }
if (-not $codex) {
  $codex = Find-LatestFile "$env:LOCALAPPDATA\OpenAI\Codex\bin\*\codex.exe"
}
if (-not $codex) {
  $codex = Find-LatestFile "$env:USERPROFILE\.codex\bin\codex.exe"
}

if (-not $node) {
  Write-Host '找不到 Node.js，请先安装 Node.js 18 或更高版本。' -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}
if (-not $codex) {
  Write-Host '找不到 codex 程序，请确认已安装 Codex 桌面软件。' -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}

[System.IO.File]::WriteAllText((Join-Path $root 'paths.json'), (@{ nodePath = $node; codexPath = $codex } | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))

$ip = $null
try {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object {
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*' -and
      $_.PrefixOrigin -ne 'WellKnown'
    } |
    Select-Object -First 1).IPAddress
} catch {}

$cfgPath = Join-Path $root 'config.json'
if (-not (Test-Path $cfgPath)) {
  Write-Host '首次启动：尚未找到配置文件，将由程序自动生成配对码/密码/密钥…' -ForegroundColor Yellow
  $cfg = [pscustomobject]@{ port = 8787 }
} else {
  try {
    $cfg = Get-Content -Raw -LiteralPath $cfgPath | ConvertFrom-Json
  } catch {
    $cfg = [pscustomobject]@{ port = 8787 }
  }
}

Write-Host ''
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '  鳍点AI' -ForegroundColor Cyan
Write-Host "  电脑上打开: http://localhost:$($cfg.port)" -ForegroundColor Green
if ($ip) {
  Write-Host "  手机上打开: http://$ip`:$($cfg.port)" -ForegroundColor Green
  Write-Host '  (手机和电脑需连同一个 Wi-Fi)' -ForegroundColor DarkGray
}
Write-Host "  访问密码: $($cfg.password)" -ForegroundColor Yellow
Write-Host '  关闭本窗口即停止服务' -ForegroundColor DarkGray
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host ''

# 日志同时显示在窗口里并自动存文件（诊断用，用户无需查看）
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$bridgeLog = Join-Path $logDir 'bridge.log'
$bridgeErr = Join-Path $logDir 'bridge.log.err'
$restartLeft = 3
while ($restartLeft -gt 0) {
  $p = Start-Process -FilePath $node -ArgumentList @((Join-Path $root 'server.js')) -RedirectStandardOutput $bridgeLog -RedirectStandardError $bridgeErr -NoNewWindow -PassThru
  $p.WaitForExit()
  $code = $p.ExitCode
  if ($code -eq 0) { break }
  $restartLeft--
  Write-Host ''
  Write-Host "服务异常退出（退出码 $code），日志见 logs\bridge.log / logs\bridge.log.err" -ForegroundColor Red
  if ($restartLeft -gt 0) {
    Write-Host "5 秒后自动重启，剩余 $restartLeft 次机会（按 Ctrl+C 取消）" -ForegroundColor Yellow
    Start-Sleep -Seconds 5
  } else {
    Write-Host '连续重启失败，请打开 logs\bridge.log 查看原因后重试。' -ForegroundColor Red
    Read-Host '按回车退出'
  }
}
