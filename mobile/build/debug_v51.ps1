$ErrorActionPreference = 'Continue'
$adb = 'd:\Trae Work\RetroRadioDesktop\mobile\android-sdk\platform-tools\adb.exe'
$target = 'adb-3B66170272200000-UlsokZ._adb-tls-connect._tcp'
$pkg = 'com.retro.radio'
$act = 'com.retro.radio.MainActivity'
$apkPath = 'd:\Trae Work\RetroRadioDesktop\mobile\android\app\build\outputs\apk\debug\app-debug.apk'
$logpath = 'd:\Trae Work\RetroRadioDesktop\mobile\build\log_v51_full.txt'

function Hdr([string]$m) { Write-Host ("=== " + $m + " ===") -ForegroundColor Yellow }
function Ok ([string]$m) { Write-Host ("  OK: " + $m) -ForegroundColor Green }
function Inf([string]$m) { Write-Host ("  " + $m) -ForegroundColor Gray }
function Warn([string]$m) { Write-Host ("  ! " + $m) -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host ("  X " + $m) -ForegroundColor Red }

Hdr "[1/7] Uninstall v50"
try {
    $raw = cmd /c "`"$adb`" -s `"$target`" uninstall $pkg" 2`>`&1
    Inf ("uninstall -> " + (($raw | Out-String).Trim()))
} catch {}

Hdr "[2/7] Install v51 APK (push + pm install)"
$installOk = $false
try { cmd /c "`"$adb`" -s `"$target`" shell rm /data/local/tmp/retroradio.apk" 2`>`&1 | Out-Null } catch {}
try {
    $raw = cmd /c "`"$adb`" -s `"$target`" push `"$apkPath`" /data/local/tmp/retroradio.apk" 2`>`&1
    foreach ($L in (($raw | Out-String).Trim() -split "`r?`n")) { if ($L) { Inf ("  push: " + $L) } }
} catch {}
try {
    $raw = cmd /c "`"$adb`" -s `"$target`" shell pm install -r -d /data/local/tmp/retroradio.apk" 2`>`&1
    $joined = ($raw | Out-String).Trim()
    if ($joined -match 'Success') { Ok ("pm install -> Success (v51)") ; $installOk = $true }
    else { Fail ("pm install -> " + $joined) }
} catch {}
if (-not $installOk) { Warn "aborting install failed"; exit 1 }

Hdr "[3/7] Dismiss modals (3x BACK)"
for ($i = 0; $i -lt 3; $i++) {
    try { cmd /c "`"$adb`" -s `"$target`" shell input keyevent KEYCODE_BACK" 2`>`&1 | Out-Null } catch {}
    Start-Sleep -Milliseconds 350
}

Hdr "[4/7] logcat -c, start capture (default main/system/crash)"
try { cmd /c "`"$adb`" -s `"$target`" logcat -c" 2`>`&1 | Out-Null } catch {}
Start-Sleep -Milliseconds 300
$logproc = Start-Process -FilePath $adb -ArgumentList @('logcat', '-v', 'threadtime') `
    -RedirectStandardOutput $logpath -NoNewWindow -PassThru
Inf ("logproc id=" + $logproc.Id + ", running=" + (-not $logproc.HasExited) + ", -> " + $logpath)
Start-Sleep -Milliseconds 1200
if ($logproc.HasExited) {
    Warn ("logproc EXITED EARLY (exit=" + $logproc.ExitCode + ")")
    try { Stop-Process -Id $logproc.Id -Force -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Milliseconds 400
    $logproc = Start-Process -FilePath $adb -ArgumentList @('-s', $target, 'logcat', '-v', 'threadtime') `
        -RedirectStandardOutput $logpath -NoNewWindow -PassThru
    Start-Sleep -Milliseconds 1200
    Inf ("logproc retry id=" + $logproc.Id + ", running=" + (-not $logproc.HasExited))
}

Hdr "[5/7] force-stop + cold launch app + 3x BACK"
try { cmd /c "`"$adb`" -s `"$target`" shell am force-stop $pkg" 2`>`&1 | Out-Null } catch {}
Start-Sleep -Milliseconds 500
try {
    $raw = cmd /c "`"$adb`" -s `"$target`" shell am start -S -W -n `"$pkg/$act`"" 2`>`&1
    foreach ($L in (($raw | Out-String).Trim() -split "`r?`n" | Select-Object -First 6)) { if ($L) { Inf ("  start: " + $L) } }
} catch {}
Start-Sleep -Milliseconds 1800
for ($i = 0; $i -lt 3; $i++) {
    try { cmd /c "`"$adb`" -s `"$target`" shell input keyevent KEYCODE_BACK" 2`>`&1 | Out-Null } catch {}
    Start-Sleep -Milliseconds 400
}

Hdr "[6/7] Wait 60s (T12大千 + T28宝岛 + T40final + 20s audio buffering margin)"
for ($i = 0; $i -lt 60; $i += 5) {
    $sizeKB = 0
    if (Test-Path $logpath) { try { $sizeKB = [math]::Round((Get-Item $logpath).Length / 1KB, 1) } catch {} }
    Inf ("  elapsed " + $i + "s / 60s  logproc alive=" + (-not $logproc.HasExited) + "  logsize=" + $sizeKB + "KB")
    Start-Sleep -Seconds 5
}

Hdr "[7/7] Stop logcat and filter"
try { if (-not $logproc.HasExited) { Stop-Process -Id $logproc.Id -Force -ErrorAction SilentlyContinue } } catch {}
Start-Sleep -Milliseconds 900

if (Test-Path $logpath) {
    $info = Get-Item $logpath
    $lc = (Get-Content $logpath).Count
    $mb = [math]::Round($info.Length / 1MB, 2)
    Ok ("log: lines=" + $lc + " size=" + $mb + "MB -> " + $logpath)
}

Write-Host ""
Write-Host "================== FILTERED LOG v51 (Playback Result Focus) ==================" -ForegroundColor Cyan
if (Test-Path $logpath) {
    $re = '(RetroRadio|WebEngine|AUTOv|FINAL FAIL|attempt failed|Retrying once|IcyCleanProxy|handleClient|wrapUrlViaProxy|play promise|timeout 12s|audio onerror|hls fatal|proxy port|IcyCleanProxy port|playChannel|playUrl|reportMeta|MediaError|MEDIA_ERR|evaluateJavascript|DebugEvalReceiver|nativeRadio|dispatchJsEvent|chromium.*Console|chromium.*[Mm]edia|chromium.*[Aa]udio|chromium.*error|net::ERR_|Mixed Content|WebView.*console|ICY 200 OK|icy-metaint|127\.0\.0\.1|INFO:CONSOLE|AndroidRuntime|FATAL EXCEPTION|ConsoleMessage|play\(\)|onCreate|handleClient|handleICY|ICY HTTP|onplaying|oncanplay|ondurationchange|onloadeddata|onloadstart|nativeRadio\] on play|nativeRadio\] on pause|internal state update only)'
    $m = Get-Content $logpath | Select-String -Pattern $re
    if (-not $m) {
        Warn "(no regex matches, dumping last 300 raw lines)"
        Get-Content $logpath | Select-Object -Last 300
    } else {
        $rows = $m | ForEach-Object { $_.Line }
        Inf ("regex hits=" + $rows.Count + " lines, showing LAST 700:")
        Write-Host ""
        $rows | Select-Object -Last 700
    }
}

Write-Host ""
Write-Host ("DONE - raw log: " + $logpath) -ForegroundColor Green
