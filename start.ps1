$ErrorActionPreference = 'Stop'
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

@{ nodePath = $node; codexPath = $codex } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'paths.json') -Encoding UTF8

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

$cfg = Get-Content -Raw -LiteralPath (Join-Path $root 'config.json') | ConvertFrom-Json

Write-Host ''
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '  Codex 手机遥控' -ForegroundColor Cyan
Write-Host "  电脑上打开: http://localhost:$($cfg.port)" -ForegroundColor Green
if ($ip) {
  Write-Host "  手机上打开: http://$ip`:$($cfg.port)" -ForegroundColor Green
  Write-Host '  (手机和电脑需连同一个 Wi-Fi)' -ForegroundColor DarkGray
}
Write-Host "  访问密码: $($cfg.password)" -ForegroundColor Yellow
Write-Host '  关闭本窗口即停止服务' -ForegroundColor DarkGray
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host ''

& $node (Join-Path $root 'server.js')
