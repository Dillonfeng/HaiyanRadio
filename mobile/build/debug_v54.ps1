# ============ RetroRadio v54 SILENT DEBUG DEPLOY SCRIPT ============
# 特点：静默安装不弹用户确认、自动授权限、屏幕常亮解锁、自动抓log
$ErrorActionPreference = 'Continue'
$WorkingDir = Split-Path -Parent $PSScriptRoot  # mobile/
$APK = "$WorkingDir\android\app\build\outputs\apk\debug\app-debug.apk"
$LOG = "$WorkingDir\build\logcat_v54_$(Get-Date -Format 'HHmmss').txt"
$PKG = 'com.retro.radio'

Write-Host "=== [v54] Step 0: 定位ADB + 检查设备 ===" -ForegroundColor Cyan
$ADB = Get-Command adb -ErrorAction SilentlyContinue
if (-not $ADB) {
    $androidHome = $env:ANDROID_HOME
    if (-not $androidHome) { $androidHome = $env:ANDROID_SDK_ROOT }
    if ($androidHome) { $ADB = Join-Path $androidHome 'platform-tools\adb.exe' }
    if (-not (Test-Path $ADB)) { $ADB = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" }
}
if (-not (Test-Path $ADB)) { Write-Error "ADB not found!"; exit 1 }
Write-Host "ADB = $ADB"

& $ADB start-server
$devices = & $ADB devices | Select-String -Pattern '\tdevice$'
if (-not $devices) {
    Write-Host "[WARN] No device connected, trying wireless reconnect..." -ForegroundColor Yellow
    $ips = @('192.168.0.103:42645','192.168.0.103:40737','192.168.1.103:5555')
    foreach ($ip in $ips) { & $ADB connect $ip 2>&1 | Out-Null; Start-Sleep -Milliseconds 600 }
    $devices = & $ADB devices | Select-String -Pattern '\tdevice$'
    if (-not $devices) { Write-Error "STILL no device. Please enable wireless debug on OPPO Reno14 and pair."; exit 2 }
}
Write-Host "Devices OK:" -ForegroundColor Green
$devices | ForEach-Object { Write-Host "  $_" }

$D = if ($devices.Count -gt 1) { @() } else { @() }
function Run-ADB { param([string[]]$Args) $all = @(); if ($D.Count) { $all += @('-s',$D[0]) }; $all += $Args; & $ADB @all }

Write-Host "=== [v54] Step 1: 准备设备 ===" -ForegroundColor Cyan
# 解锁屏幕 + 常亮 (尽量不要求用户交互)
Run-ADB @('shell','input','keyevent','KEYCODE_WAKEUP') 2>&1 | Out-Null; Start-Sleep -Milliseconds 400
Run-ADB @('shell','input','swipe','530','2000','530','600','200') 2>&1 | Out-Null; Start-Sleep -Milliseconds 300
Run-ADB @('shell','settings','put','global','stay_on_while_plugged_in','7') 2>&1 | Out-Null
Run-ADB @('shell','settings','put','system','screen_off_timeout','600000') 2>&1 | Out-Null
Run-ADB @('shell','am','force-stop',$PKG) 2>&1 | Out-Null; Start-Sleep -Milliseconds 600

Write-Host "=== [v54] Step 2: Cap sync (拷贝www到android assets) ===" -ForegroundColor Cyan
Push-Location $WorkingDir
try {
    npx cap sync android 2>&1 | ForEach-Object { Write-Host "  [cap] $_" }
    if ($LASTEXITCODE -ne 0) { Write-Host "[cap sync] failed but try gradle anyway" -ForegroundColor Yellow }
} finally { Pop-Location }

Write-Host "=== [v54] Step 3: Gradle assembleDebug ===" -ForegroundColor Cyan
Push-Location "$WorkingDir\android"
try {
    if (Test-Path 'gradlew.bat') { $gw = '.\gradlew.bat' } else { $gw = 'gradlew.bat' }
    & $gw ':app:assembleDebug' '--no-daemon' '-q' 2>&1 | ForEach-Object {
        if ($_ -match 'FAIL|error:|Exception') { Write-Host "  [gradle ERR] $_" -ForegroundColor Red }
        else { Write-Host "  [gradle] $_" -ForegroundColor DarkGray }
    }
    if ($LASTEXITCODE -ne 0) { Write-Error "Gradle FAIL exit=$LASTEXITCODE"; exit 3 }
} finally { Pop-Location }

if (-not (Test-Path $APK)) { Write-Error "APK not found at $APK"; exit 4 }
$apkSize = (Get-Item $APK).Length
Write-Host "[OK] APK: $APK ($([int]($apkSize/1KB)) KB)" -ForegroundColor Green

Write-Host "=== [v54] Step 4: 清空logcat并静默安装 + 授权限 ===" -ForegroundColor Cyan
Run-ADB @('logcat','-c') 2>&1 | Out-Null
# 静默安装 -r (replace existing，不弹用户确认框)
Write-Host "  adb install -r (silent replace)..." -ForegroundColor DarkCyan
$installOut = Run-ADB @('install','-r',$APK) 2>&1
$installOut | ForEach-Object { Write-Host "  [install] $_" }
if (($installOut | Out-String) -notmatch 'Success') {
    Write-Host "[WARN] install -r failed, try uninstall first (will clear data!)" -ForegroundColor Yellow
    Run-ADB @('uninstall',$PKG) 2>&1 | ForEach-Object { Write-Host "  [uninstall] $_" }
    Start-Sleep -Milliseconds 800
    $installOut = Run-ADB @('install',$APK) 2>&1
    $installOut | ForEach-Object { Write-Host "  [install] $_" }
}
Start-Sleep -Milliseconds 1200

# 静默授权所有权限 (不弹任何用户对话框！)
Write-Host "  Grant all runtime permissions SILENTLY..." -ForegroundColor DarkCyan
$perms = @(
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    'android.permission.WAKE_LOCK',
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.ACCESS_WIFI_STATE'
)
foreach ($p in $perms) { Run-ADB @('shell','pm','grant',$PKG,$p) 2>&1 | Out-Null }
# 电池优化白名单 (OPPO ColorOS 直接通过 settings 绕过弹窗)
Run-ADB @('shell','dumpsys','deviceidle','whitelist','+',$PKG) 2>&1 | Out-Null
Write-Host "  Permissions granted." -ForegroundColor Green

Write-Host "=== [v54] Step 5: 后台启动logcat抓取 ===" -ForegroundColor Cyan
# 使用cmd /c重定向直接到文件，避免Start-Process问题
$null = New-Item -ItemType Directory -Force (Split-Path $LOG)
Start-Job -Name "logcat_v54" -ScriptBlock {
    param($adb,$log,$pkg)
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','User')
    cmd /c "`"$adb`" logcat -v time *:V RetroRadioSvc:D RetroRadioMain:D RetroRadioBridge:D RetroRadioAuto:D chromium:I MediaSession:I AudioManager:I > `"$log`" 2>&1"
} -ArgumentList $ADB,$LOG,$PKG | Out-Null
Start-Sleep -Milliseconds 900
Write-Host "  Logcat tail -> $LOG" -ForegroundColor DarkGray

Write-Host "=== [v54] Step 6: 冷启动 APP ===" -ForegroundColor Cyan
Run-ADB @('shell','am','start','-n','com.retro.radio/.MainActivity','-a','android.intent.action.MAIN','-c','android.intent.category.LAUNCHER') 2>&1 | Out-Null
Start-Sleep -Seconds 4

Write-Host "=== [v54] DEPLOY OK ===" -ForegroundColor Green
Write-Host "  APK:       $APK"
Write-Host "  Logcat:    $LOG"
Write-Host "  Tip: 打开APP后请手动测试：" -ForegroundColor Yellow
Write-Host "       1) 普通电台 (如央广中国之声) - 验证基础播放OK"
Write-Host "       2) 大千电台FM99.1 (台湾ICy) - 验证ICy流OK"
Write-Host "       3) 宝岛联播网 / 良友 / 光华之声 - 验证之前有问题的台湾电台OK"
Write-Host ""
Write-Host "  看完问题后随时用 Ctrl+C 停止脚本，再检查logcat尾巴"
Write-Host ""
Write-Host "  每10秒自动打印一段logcat尾巴给你（Ctrl+C退出）:" -ForegroundColor Cyan

try {
    while ($true) {
        Start-Sleep -Seconds 10
        if (Test-Path $LOG) {
            $lines = Get-Content $LOG -Tail 20 -ErrorAction SilentlyContinue
            Write-Host "`n---- logcat tail (T=$(Get-Date -Format 'HH:mm:ss')) ----" -ForegroundColor DarkCyan
            $lines | Select-String -Pattern 'playChannel|WebEngine|RetroRadio|onplaying|onerror|MediaPlayer|audio|ICY|HLS|play\(\)' | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
        }
    }
} finally {
    Write-Host "`n停止logcat..." -ForegroundColor Yellow
    Get-Job -Name "logcat_v54" -ErrorAction SilentlyContinue | Stop-Job -PassThru | Remove-Job -Force
    Run-ADB @('shell','pkill','-f','logcat') 2>&1 | Out-Null
    Write-Host "Done. Log file: $LOG" -ForegroundColor Green
}
