param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('list', 'open', 'open-background', 'home', 'uninstall', 'app-settings', 'ignore-battery')]
  [string]$Action,
  [string]$Package
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'config.json') | ConvertFrom-Json
$base = 'http://127.0.0.1:' + $cfg.port

if (($Action -in @('open', 'open-background', 'uninstall', 'app-settings')) -and [string]::IsNullOrWhiteSpace($Package)) {
  Write-Error '该操作需要 -Package 参数（应用包名）'
  exit 1
}

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-RestMethod -Uri "$base/api/login" -Method POST -ContentType 'application/json' `
  -Body (@{ password = $cfg.password } | ConvertTo-Json) -WebSession $session | Out-Null

switch ($Action) {
  'list' {
    $r = Invoke-RestMethod -Uri "$base/api/phone/apps" -Method POST -ContentType 'application/json' -Body '{}' -WebSession $session
    $r.apps | ConvertTo-Json -Depth 5
  }
  'open' {
    Invoke-RestMethod -Uri "$base/api/phone/open" -Method POST -ContentType 'application/json' -Body (@{ package = $Package } | ConvertTo-Json) -WebSession $session | ConvertTo-Json -Depth 5
  }
  'open-background' {
    Invoke-RestMethod -Uri "$base/api/phone/open-background" -Method POST -ContentType 'application/json' -Body (@{ package = $Package } | ConvertTo-Json) -WebSession $session | ConvertTo-Json -Depth 5
  }
  'home' {
    Invoke-RestMethod -Uri "$base/api/phone/home" -Method POST -ContentType 'application/json' -Body '{}' -WebSession $session | ConvertTo-Json -Depth 5
  }
  'uninstall' {
    Invoke-RestMethod -Uri "$base/api/phone/uninstall" -Method POST -ContentType 'application/json' -Body (@{ package = $Package } | ConvertTo-Json) -WebSession $session | ConvertTo-Json -Depth 5
  }
  'app-settings' {
    Invoke-RestMethod -Uri "$base/api/phone/app-settings" -Method POST -ContentType 'application/json' -Body (@{ package = $Package } | ConvertTo-Json) -WebSession $session | ConvertTo-Json -Depth 5
  }
  'ignore-battery' {
    Invoke-RestMethod -Uri "$base/api/phone/ignore-battery" -Method POST -ContentType 'application/json' -Body '{}' -WebSession $session | ConvertTo-Json -Depth 5
  }
}
