$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$sdk = ''
if ($env:ANDROID_SDK_ROOT -and (Test-Path $env:ANDROID_SDK_ROOT)) { $sdk = $env:ANDROID_SDK_ROOT }
elseif ($env:ANDROID_HOME -and (Test-Path $env:ANDROID_HOME)) { $sdk = $env:ANDROID_HOME }
else {
  foreach ($cand in @("$env:LOCALAPPDATA\Android\Sdk", 'C:\Android\Sdk', "$env:USERPROFILE\AppData\Local\Android\Sdk")) {
    if ($cand -and (Test-Path $cand)) { $sdk = $cand; break }
  }
}
if (-not $sdk) { throw '未找到 Android SDK，请安装 Android SDK 或设置 ANDROID_SDK_ROOT 环境变量' }
$buildToolsDir = Get-ChildItem (Join-Path $sdk 'build-tools') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
$platformDir = Get-ChildItem (Join-Path $sdk 'platforms') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if (-not $buildToolsDir) { throw "找不到 Android 打包工具: $(Join-Path $sdk 'build-tools')" }
if (-not $platformDir) { throw "找不到 Android 平台库: $(Join-Path $sdk 'platforms')" }
$bt = $buildToolsDir.FullName
$platform = $platformDir.FullName
$androidJar = Join-Path $platform 'android.jar'
if (-not (Test-Path $androidJar)) { throw "找不到 Android 平台库: $androidJar" }

# 找一个 Java 11 以上的运行环境（d8 和 APK 签名需要）
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$javaHome = ''
$javaCandidates = @()
if ($env:JAVA_HOME) { $javaCandidates += $env:JAVA_HOME }
$javaCandidates += "$env:USERPROFILE\.jdks"
$javaCandidates += 'C:\Program Files\Android\Android Studio\jbr'
$javaCandidates += 'C:\Program Files\Eclipse Adoptium'
$javaCandidates += 'C:\Program Files\Microsoft\jdk-11*'
foreach ($c in $javaCandidates) {
  $j = Join-Path $c 'bin\java.exe'
  if (-not (Test-Path $j)) {
    $cands = Get-ChildItem -Path $c -Filter java.exe -Recurse -Depth 3 -ErrorAction SilentlyContinue
    foreach ($fj in $cands) {
      $ver = (& $fj.FullName -version 2>&1 | Select-Object -First 1)
      if ($ver -match 'version "(\d+)' -and [int]$Matches[1] -ge 11) {
        $javaHome = Split-Path -Parent (Split-Path -Parent $fj.FullName)
        break
      }
    }
    if ($javaHome) { break }
    continue
  }
  $ver = (& $j -version 2>&1 | Select-Object -First 1)
  if ($ver -match 'version "(\d+)' -and [int]$Matches[1] -ge 11) { $javaHome = $c; break }
}
if (-not $javaHome) {
  $j = Get-ChildItem 'C:\Program Files\Java' -Filter 'java.exe' -Recurse -Depth 2 -ErrorAction SilentlyContinue | Where-Object {
    $v = (& $_.FullName -version 2>&1 | Select-Object -First 1)
    $v -match 'version "(\d+)' -and [int]$Matches[1] -ge 11
  } | Select-Object -First 1
  if ($j) { $javaHome = Split-Path -Parent (Split-Path -Parent $j.FullName) }
}
$ErrorActionPreference = $prevEap
if (-not $javaHome) { throw '找不到 Java 11 以上版本，无法打包 APK' }
$javaBin = Join-Path $javaHome 'bin'
Write-Host "使用 Java: $javaBin"

$proj = Join-Path $root 'android'
$src = Join-Path $proj 'src'
$manifest = Join-Path $proj 'AndroidManifest.xml'
$resDir = Join-Path $proj 'res\drawable'
$build = Join-Path $proj 'build'

if (Test-Path $build) { Remove-Item -LiteralPath $build -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $build 'classes') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $build 'dex') | Out-Null

# 生成应用图标（只生成一次）
$icon = Join-Path $resDir 'ic_launcher.png'
if (-not (Test-Path $icon)) {
    New-Item -ItemType Directory -Force -Path $resDir | Out-Null
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap 192, 192
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::FromArgb(255, 15, 17, 21))
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 16, 163, 127))
    $g.FillEllipse($brush, 26, 26, 140, 140)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 14
    $g.DrawRectangle($pen, 62, 52, 68, 96)
    $g.DrawLine($pen, 84, 132, 108, 132)
    $font = New-Object System.Drawing.Font('Arial', 34, [System.Drawing.FontStyle]::Bold)
    $g.DrawString('>_', $font, [System.Drawing.Brushes]::White, 98, 70)
    $bmp.Save($icon, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
}

# 把网页界面打包进 APK（中继模式用）
$www = Join-Path $proj 'assets\www'
if (Test-Path $www) { Remove-Item -LiteralPath $www -Recurse -Force }
New-Item -ItemType Directory -Force -Path $www | Out-Null
Copy-Item -Path (Join-Path $root 'public\*') -Destination $www -Recurse -Force

Write-Host '1/6 编译 Java 代码...'
$javaFiles = Get-ChildItem -LiteralPath $src -Recurse -Filter '*.java' | ForEach-Object { $_.FullName }
& javac -encoding UTF-8 -source 1.8 -target 1.8 -bootclasspath $androidJar -d (Join-Path $build 'classes') $javaFiles
if ($LASTEXITCODE -ne 0) { throw 'Java 编译失败' }

Write-Host '2/6 生成 dex...'
$classFiles = Get-ChildItem -LiteralPath (Join-Path $build 'classes') -Recurse -Filter '*.class' | ForEach-Object { $_.FullName }
& (Join-Path $javaBin 'java.exe') -cp (Join-Path $bt 'lib\d8.jar') com.android.tools.r8.D8 --release --lib $androidJar --output (Join-Path $build 'dex') $classFiles
if ($LASTEXITCODE -ne 0) { throw 'd8 失败' }

Write-Host '3/6 打包资源...'
& (Join-Path $bt 'aapt2.exe') compile --dir (Join-Path $proj 'res') -o (Join-Path $build 'res.zip')
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile 失败' }
& (Join-Path $bt 'aapt2.exe') link -o (Join-Path $build 'base.apk') -I $androidJar --manifest $manifest --min-sdk-version 24 --target-sdk-version 34 (Join-Path $build 'res.zip')
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link 失败' }

Write-Host '4/6 合并 dex 并对齐...'
Push-Location (Join-Path $build 'dex')
& (Join-Path $javaBin 'jar.exe') uf (Join-Path $build 'base.apk') classes.dex
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'jar 失败' }
Pop-Location
& (Join-Path $javaBin 'jar.exe') uf (Join-Path $build 'base.apk') -C $proj assets
if ($LASTEXITCODE -ne 0) { throw 'assets 添加失败' }
& (Join-Path $bt 'zipalign.exe') -f 4 (Join-Path $build 'base.apk') (Join-Path $build 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw 'zipalign 失败' }

Write-Host '5/6 签名...'
$ks = Join-Path $proj 'debug.keystore'
if (-not (Test-Path $ks)) {
    $prevEap2 = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & (Join-Path $javaBin 'keytool.exe') -genkeypair -v -keystore $ks -alias codex -keyalg RSA -keysize 2048 -validity 10000 -storepass codexbridge -keypass codexbridge -dname 'CN=Codex Bridge, OU=Local, O=Local, L=Local, S=Local, C=CN' 2>&1 | Out-Null
    $ErrorActionPreference = $prevEap2
    if (-not (Test-Path $ks)) { throw 'keytool 失败' }
}
& (Join-Path $javaBin 'java.exe') -jar (Join-Path $bt 'lib\apksigner.jar') sign --ks $ks --ks-pass pass:codexbridge --key-pass pass:codexbridge --out (Join-Path $build 'CodexPhoneBridge.apk') (Join-Path $build 'aligned.apk')
if ($LASTEXITCODE -ne 0) { throw '签名失败' }

Write-Host '6/6 校验...'
Copy-Item -LiteralPath (Join-Path $build 'CodexPhoneBridge.apk') -Destination (Join-Path $root 'CodexPhoneBridge.apk') -Force
& (Join-Path $javaBin 'java.exe') -jar (Join-Path $bt 'lib\apksigner.jar') verify --print-certs (Join-Path $root 'CodexPhoneBridge.apk')
& (Join-Path $bt 'aapt.exe') dump badging (Join-Path $root 'CodexPhoneBridge.apk') | Select-Object -First 8
Write-Host ''
Write-Host "完成！APK 在: $(Join-Path $root 'CodexPhoneBridge.apk')" -ForegroundColor Green
