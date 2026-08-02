$ErrorActionPreference = 'Continue'
$adb = 'd:\Trae Work\RetroRadioDesktop\mobile\android-sdk\platform-tools\adb.exe'
$target = 'adb-3B66170272200000-UlsokZ._adb-tls-connect._tcp'
$pkg = 'com.retro.radio'
$act = 'com.retro.radio.MainActivity'
$apkPath = 'd:\Trae Work\RetroRadioDesktop\mobile\android\app\build\outputs\apk\debug\app-debug.apk'
$logpath = 'd:\Trae Work\RetroRadioDesktop\mobile\build\log_v52_full.txt'

function Hdr([string]$m) { Write-Host ("=== " + $m + " ===") -ForegroundColor Yellow }
function Ok ([string]$m) { Write-Host ("  OK: " + $m) -ForegroundColor Green }
function Inf([string]$m) { Write-Host ("  " + $m) -ForegroundColor Gray }
function Warn([string]$m) { Write-Host ("  ! " + $m) -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host ("  X " + $m) -ForegroundColor Red }

function Adb([string[]]$argslist) {
    $fullArgs = @('-s', $target) + $argslist
    $pinfo = New-Object System.Diagnostics.ProcessStartInfo
    $pinfo.FileName = $adb
    $sb = New-Object System.Text.StringBuilder
    foreach ($a in $fullArgs) {
        if ($sb.Length -gt 0) { [void]$sb.Append(' ') }
        if ($a -match '\s') { [void]$sb.Append('"').Append($a).Append('"') }
        else { [void]$sb.Append($a) }
    }
    $pinfo.Arguments = $sb.ToString()
    $pinfo.RedirectStandardOutput = $true
    $pinfo.RedirectStandardError = $true
    $pinfo.UseShellExecute = $false
    $p = [System.Diagnostics.Process]::Start($pinfo)
    $so = $p.StandardOutput.ReadToEnd()
    $se = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    return [pscustomobject]@{ ExitCode = $p.ExitCode; Out = ($so.Trim() + " " + $se.Trim()).Trim() }
}

Hdr "[0/8] Ensure device online"
$try = 0
$st = Adb @('get-state')
while ($st.Out -notmatch 'device$' -and $try -lt 5) {
    Warn ("device not ready, reconnect adb attempt " + $try + ": " + $st.Out)
    $null = & $adb kill-server 2>$null
    Start-Sleep -Milliseconds 1000
    $null = & $adb start-server 2>$null
    Start-Sleep -Milliseconds 4000
    $try++
    $st = Adb @('get-state')
}
Inf ("get-state -> [" + $st.ExitCode + "] " + $st.Out)
if ($st.Out -notmatch 'device$') { Fail "device offline, abort"; exit 1 }
Ok "device online"

Hdr "[1/8] Device prep: wake+unlock+stay-awake (no user interaction)"
$null = Adb @('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
Start-Sleep -Milliseconds 450
$null = Adb @('shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', '7')
$null = Adb @('shell', 'svc', 'power', 'stayon', 'true')
Start-Sleep -Milliseconds 300
$null = Adb @('shell', 'am', 'broadcast', '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS')
for ($i = 0; $i -lt 3; $i++) { $null = Adb @('shell', 'input', 'keyevent', 'KEYCODE_MENU'); Start-Sleep -Milliseconds 260 }
$null = Adb @('shell', 'input', 'swipe', '540', '1600', '540', '700', '260')
Start-Sleep -Milliseconds 600
Ok "device awake + dismiss-keyguard + stay-on"

Hdr "[2/8] Silent install v52 (adb install -r -d then fallback push+pm)"
$u = Adb @('shell', 'pm', 'uninstall', '--user', '0', $pkg)
Inf ("pm uninstall -> " + $u.Out)
Start-Sleep -Milliseconds 400

$inst1 = Adb @('install', '-r', '-d', $apkPath)
Inf ("adb install -r -d -> [" + $inst1.ExitCode + "] " + $inst1.Out)
$installOk = ($inst1.Out -match 'Success')
if (-not $installOk) {
    Warn "adb install -r -d no Success; fallback: adb push + shell pm install -r"
    $null = Adb @('shell', 'rm', '-f', '/data/local/tmp/retroradio52.apk')
    Start-Sleep -Milliseconds 200
    $p = Adb @('push', $apkPath, '/data/local/tmp/retroradio52.apk')
    Inf ("adb push -> [" + $p.ExitCode + "] " + $p.Out)
    $i2 = Adb @('shell', 'pm', 'install', '-r', '/data/local/tmp/retroradio52.apk')
    Inf ("pm install -r -> [" + $i2.ExitCode + "] " + $i2.Out)
    $installOk = ($i2.Out -match 'Success')
    if (-not $installOk) {
        Warn "pm install -r no Success; fallback adb install -r (no -d)"
        $i3 = Adb @('install', '-r', $apkPath)
        Inf ("adb install -r -> [" + $i3.ExitCode + "] " + $i3.Out)
        $installOk = ($i3.Out -match 'Success')
    }
}
if (-not $installOk) { Fail "v52 install FAIL (no Success msg)"; exit 1 }
Ok "v52 installed silently (no user clicks/dialogs)"

Hdr "[3/8] Grant permissions + dismiss system dialogs"
$perms = @(
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    'android.permission.WAKE_LOCK'
)
foreach ($perm in $perms) { $null = Adb @('shell', 'pm', 'grant', $pkg, $perm) }
$null = Adb @('shell', 'appops', 'set', '--uid', $pkg, 'POST_NOTIFICATIONS', 'allow')
$null = Adb @('shell', 'settings', 'put', 'secure', 'anr_show_background', '0')
$null = Adb @('shell', 'am', 'broadcast', '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS')
for ($i = 0; $i -lt 5; $i++) { $null = Adb @('shell', 'input', 'keyevent', 'KEYCODE_BACK'); Start-Sleep -Milliseconds 220 }
Ok "perms granted; system dialogs dismissed"

Hdr "[4/8] logcat -c + start full capture (all buffers)"
$null = Adb @('logcat', '-c', '-b', 'all')
Start-Sleep -Milliseconds 500
if (Test-Path $logpath) { try { Remove-Item -Force -ErrorAction SilentlyContinue } catch {} }
$logArgs = @('-s', $target, 'logcat', '-b', 'all', '-v', 'threadtime')
$linfo = New-Object System.Diagnostics.ProcessStartInfo
$linfo.FileName = $adb
$sb = New-Object System.Text.StringBuilder
foreach ($a in $logArgs) {
    if ($sb.Length -gt 0) { [void]$sb.Append(' ') }
    if ($a -match '\s') { [void]$sb.Append('"').Append($a).Append('"') }
    else { [void]$sb.Append($a) }
}
$linfo.Arguments = $sb.ToString()
$linfo.RedirectStandardOutput = $logpath
$linfo.UseShellExecute = $false
$logproc = [System.Diagnostics.Process]::Start($linfo)
Start-Sleep -Milliseconds 1600
if ($logproc.HasExited) {
    Warn ("logcat proc exited early exit=" + $logproc.ExitCode + ". Restart adb + logcat.")
    & $adb kill-server 2>$null | Out-Null
    Start-Sleep 1
    & $adb start-server 2>$null | Out-Null
    Start-Sleep 4
    $logproc = [System.Diagnostics.Process]::Start($linfo)
    Start-Sleep -Milliseconds 1600
}
Inf ("logproc id=" + $logproc.Id + " alive=" + (-not $logproc.HasExited) + " -> " + $logpath)

Hdr "[5/8] force-stop + cold launch MainActivity (no user launcher tap)"
$null = Adb @('shell', 'am', 'force-stop', $pkg)
Start-Sleep -Milliseconds 650
$s = Adb @('shell', 'am', 'start', '-S', '-W', '-n', "$pkg/$act")
Inf ("am start -> " + (($s.Out -split "`r?`n" | Select-Object -First 5) -join " | "))
Start-Sleep -Milliseconds 1700
for ($i = 0; $i -lt 3; $i++) { $null = Adb @('shell', 'input', 'keyevent', 'KEYCODE_BACK'); Start-Sleep -Milliseconds 250 }
Ok "app cold-launched (fully automated)"

Hdr "[6/8] Wait 75s: T+12s大千 T+28s宝岛 T+60s final dump (>20s audio buffer margin)"
for ($i = 0; $i -lt 75; $i += 5) {
    $sizeKB = 0
    if (Test-Path $logpath) { try { $sizeKB = [math]::Round((Get-Item $logpath).Length / 1KB, 1) } catch {} }
    $alive = -not $logproc.HasExited
    Inf ("  " + $i + "s / 75s   logproc alive=" + $alive + "   logsize=" + $sizeKB + "KB")
    Start-Sleep -Seconds 5
}

Hdr "[7/8] Stop logcat capture"
try { if (-not $logproc.HasExited) { Stop-Process -Id $logproc.Id -Force -ErrorAction SilentlyContinue } } catch {}
Start-Sleep -Milliseconds 900
if (Test-Path $logpath) {
    $info = Get-Item $logpath
    $lc = (Get-Content $logpath).Count
    $mb = [math]::Round($info.Length / 1MB, 2)
    Ok ("log captured lines=" + $lc + " size=" + $mb + "MB -> " + $logpath)
}

Write-Host ""
Write-Host "================== FILTERED LOG v52 (Playback Outcome) ==================" -ForegroundColor Cyan
if (Test-Path $logpath) {
    $regex = @'
(RetroRadio|WebEngine|AUTOv|FINAL FAIL|attempt failed|Retrying once|onplaying OK|stale seq|post-wait retry|ignore this STOP|IcyCleanProxy|handleClient FAIL|wrapUrlViaProxy|play promise|timeout 12s|audio onerror|hls fatal|proxy port|playChannel|seq=.*SKIP|reportMeta|MediaError|MEDIA_ERR|evaluateJavascript|DebugEvalReceiver|nativeRadio event=|dispatchJsEvent|chromium.*Console|chromium.*[Mm]edia|chromium.*[Aa]udio|chromium.*error|net::ERR_|Mixed Content|WebView.*console|ICY 200 OK|icy-metaint|127\.0\.0\.1|INFO:CONSOLE|AndroidRuntime|FATAL EXCEPTION|ConsoleMessage|onCreate|handleICY|ICY HTTP|oncanplay|onloadeddata|nativeRadio\] on play|nativeRadio\] on pause|nativeRadio\] on stop|internal state update only|SKIP \(either)
'@
    $m = Get-Content $logpath | Select-String -Pattern $regex
    if (-not $m) {
        Warn "(no regex matches, dumping last 400 raw lines)"
        Get-Content $logpath | Select-Object -Last 400
    } else {
        $rows = @($m | ForEach-Object { $_.Line })
        Inf ("regex hits=" + $rows.Count + " lines, LAST 1000 below:")
        Write-Host ""
        $rows | Select-Object -Last 1000
    }
}

Write-Host ""
Write-Host ("[FINISH] raw log: " + $logpath) -ForegroundColor Green
