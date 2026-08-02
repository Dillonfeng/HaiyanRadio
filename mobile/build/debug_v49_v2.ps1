$ErrorActionPreference = 'Continue'
$adb = 'd:\Trae Work\RetroRadioDesktop\mobile\android-sdk\platform-tools\adb.exe'
$target = 'adb-3B66170272200000-UlsokZ._adb-tls-connect._tcp'
$pkg = 'com.retro.radio'
$act = 'com.retro.radio.MainActivity'
$apkPath = 'd:\Trae Work\RetroRadioDesktop\mobile\android\app\build\outputs\apk\debug\app-debug.apk'
$logpath = 'd:\Trae Work\RetroRadioDesktop\mobile\build\log_v49_full.txt'

function Hdr([string]$m) { Write-Host ("=== " + $m + " ===") -ForegroundColor Yellow }
function Ok ([string]$m) { Write-Host ("  OK: " + $m) -ForegroundColor Green }
function Inf([string]$m) { Write-Host ("  " + $m) -ForegroundColor Gray }
function Warn([string]$m) { Write-Host ("  ! " + $m) -ForegroundColor Yellow }
function Fail([string]$m) { Write-Host ("  X " + $m) -ForegroundColor Red }

Hdr "[1/6] Uninstall old APK"
try {
    $raw = cmd /c "`"$adb`" -s `"$target`" uninstall $pkg" 2`>`&1
    $joined = ($raw | Out-String).Trim()
    Inf ("uninstall -> " + $joined)
} catch {}

Hdr "[2/6] Install v49 APK (push + pm install fallback from start)"
$installOk = $false
try { cmd /c "`"$adb`" -s `"$target`" shell rm /data/local/tmp/retroradio.apk" 2`>`&1 | Out-Null } catch {}
try {
    $raw = cmd /c "`"$adb`" -s `"$target`" push `"$apkPath`" /data/local/tmp/retroradio.apk" 2`>`&1
    $joined = ($raw | Out-String).Trim()
    foreach ($L in ($joined -split "`r?`n")) { if ($L) { Inf ("  push: " + $L) } }
} catch {}
try {
    $raw = cmd /c "`"$adb`" -s `"$target`" shell pm install -r -d /data/local/tmp/retroradio.apk" 2`>`&1
    $joined = ($raw | Out-String).Trim()
    if ($joined -match 'Success') { Ok ("pm install -> Success") ; $installOk = $true }
    else { Fail ("pm install -> " + $joined) }
} catch {}
if (-not $installOk) { Warn "aborting install failed"; exit 1 }

Hdr "[3/6] logcat -c, then start background capture to file"
try { cmd /c "`"$adb`" -s `"$target`" logcat -c" 2`>`&1 | Out-Null } catch {}
Start-Sleep -Milliseconds 300
$logproc = Start-Process -FilePath $adb -ArgumentList @('-s', $target, 'logcat', '-v', 'threadtime', '-b', 'main,system,crash,webview') `
    -RedirectStandardOutput $logpath -NoNewWindow -PassThru
Inf ("logproc id=" + $logproc.Id + ", logfile=" + $logpath)
Start-Sleep -Milliseconds 800

Hdr "[4/6] force-stop + cold launch app"
try { cmd /c "`"$adb`" -s `"$target`" shell am force-stop $pkg" 2`>`&1 | Out-Null } catch {}
Start-Sleep -Milliseconds 500
try {
    $raw = cmd /c "`"$adb`" -s `"$target`" shell am start -S -W -n `"$pkg/$act`"" 2`>`&1
    $joined = ($raw | Out-String).Trim()
    foreach ($L in ($joined -split "`r?`n" | Select-Object -First 5)) { if ($L) { Inf ("  start: " + $L) } }
} catch {}

Hdr "[5/6] Wait 42s (13s pre-delay + 2 rounds 12s timeout + 5s margin)"
for ($i = 0; $i -lt 42; $i += 6) {
    Inf ("  elapsed " + $i + "s / 42s ...")
    Start-Sleep -Seconds 6
}

Hdr "[6/6] Stop logcat and show filtered result"
try { Stop-Process -Id $logproc.Id -Force -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 900

if (Test-Path $logpath) {
    $info = Get-Item $logpath
    $lc = (Get-Content $logpath).Count
    $mb = [math]::Round($info.Length / 1MB, 2)
    Ok ("log captured: lines=" + $lc + " size=" + $mb + "MB -> " + $logpath)
}

Write-Host ""
Write-Host "================== FILTERED LOG (RetroRadio + WebEngine + AUTOv49 + ICY) ==================" -ForegroundColor Cyan
if (Test-Path $logpath) {
    $re = '(RetroRadio|WebEngine|AUTOv49|FINAL FAIL|attempt failed|Retrying once|IcyCleanProxy|handleClient|wrapUrlViaProxy|play promise|timeout 12s|audio onerror|hls fatal|proxy port|IcyCleanProxy port|playChannel|playUrl|reportMeta|MediaError|MEDIA_ERR|evaluateJavascript|DebugEvalReceiver|nativeRadio|dispatchJsEvent|chromium.*Console|chromium.*[Mm]edia|chromium.*[Aa]udio|chromium.*error|net::ERR_|Mixed Content|WebView.*console|ICY 200 OK|icy-metaint|127\.0\.0\.1|INFO:CONSOLE|AndroidRuntime|FATAL EXCEPTION)'
    $m = Get-Content $logpath | Select-String -Pattern $re
    if (-not $m) {
        Warn "(no regex matches -> dumping last 200 raw lines)"
        Get-Content $logpath | Select-Object -Last 200
    } else {
        $rows = $m | ForEach-Object { $_.Line }
        Inf ("regex hits: " + $rows.Count + " lines, showing LAST 380:")
        Write-Host ""
        $rows | Select-Object -Last 380
    }
}

Write-Host ""
Write-Host ("DONE - raw log: " + $logpath) -ForegroundColor Green
