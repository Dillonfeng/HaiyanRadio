$ErrorActionPreference = 'Continue'
$adb = 'd:\Trae Work\RetroRadioDesktop\mobile\android-sdk\platform-tools\adb.exe'
$target = 'adb-3B66170272200000-UlsokZ._adb-tls-connect._tcp'
$pkg = 'com.retro.radio'
$act = 'com.retro.radio.MainActivity'
$apkPath = 'd:\Trae Work\RetroRadioDesktop\mobile\android\app\build\outputs\apk\debug\app-debug.apk'
$logpath = 'd:\Trae Work\RetroRadioDesktop\mobile\build\log_v49_full.txt'

function Run-Adb($argsList) {
    $all = @('-s', $target) + $argsList
    $outTmp = Join-Path $env:TEMP ("adb_out_" + [guid]::NewGuid().ToString("N") + ".txt")
    $errTmp = Join-Path $env:TEMP ("adb_err_" + [guid]::NewGuid().ToString("N") + ".txt")
    try {
        $p = Start-Process -FilePath $adb -ArgumentList $all `
            -RedirectStandardOutput $outTmp -RedirectStandardError $errTmp `
            -NoNewWindow -Wait -PassThru
        $out = if (Test-Path $outTmp) { Get-Content $outTmp -Raw } else { "" }
        $err = if (Test-Path $errTmp) { Get-Content $errTmp -Raw } else { "" }
    } finally {
        Remove-Item $outTmp -ErrorAction SilentlyContinue
        Remove-Item $errTmp -ErrorAction SilentlyContinue
    }
    return [pscustomobject]@{ ExitCode = $p.ExitCode; Out = $out.Trim(); Err = $err.Trim() }
}

Write-Host "=== [1/6] Uninstall old APK ===" -ForegroundColor Yellow
$r = Run-Adb @('uninstall', $pkg)
Write-Host ("  -> " + ($r.Out + " " + $r.Err).Trim())

Write-Host "=== [2/6] Install v49 APK ===" -ForegroundColor Yellow
$r = Run-Adb @('install', '-r', '-d', $apkPath)
$installOk = $true
if ($r.ExitCode -ne 0 -or $r.Err -match 'Failure|INSTALL_FAILED|not found|adb: failed') {
    Write-Host ("  direct install failed, trying push+pm fallback: " + $r.Err) -ForegroundColor Yellow
    Run-Adb @('shell', 'rm', '/data/local/tmp/retroradio.apk') | Out-Null
    Run-Adb @('push', $apkPath, '/data/local/tmp/retroradio.apk') | Out-Null
    $r2 = Run-Adb @('shell', 'pm', 'install', '-r', '-d', '/data/local/tmp/retroradio.apk')
    if (-not ($r2.Out -match 'Success')) { Write-Host ("  FAIL: " + $r2.Out + " | " + $r2.Err) -ForegroundColor Red ; $installOk = $false }
    else { Write-Host "  push+pm install OK" -ForegroundColor Green }
} else {
    Write-Host "  install OK" -ForegroundColor Green
    if ($r.Out) { Write-Host ("  detail: " + $r.Out) }
}
if (-not $installOk) { exit 1 }

Write-Host "=== [3/6] logcat -c + start background capture ===" -ForegroundColor Yellow
Run-Adb @('logcat', '-c') | Out-Null
Start-Sleep -Milliseconds 350
$logproc = Start-Process -FilePath $adb -ArgumentList @('-s', $target, 'logcat', '-v', 'threadtime', '-b', 'main,system,crash,webview') `
    -RedirectStandardOutput $logpath -NoNewWindow -PassThru
Start-Sleep -Milliseconds 900

Write-Host "=== [4/6] Force stop + cold launch app ===" -ForegroundColor Yellow
Run-Adb @('shell', 'am', 'force-stop', $pkg) | Out-Null
Start-Sleep -Milliseconds 600
$r = Run-Adb @('shell', 'am', 'start', '-S', '-W', '-n', "$pkg/$act")
Write-Host ("  launch result lines:")
foreach ($line in ($r.Out -split "`r?`n" | Select-Object -First 6)) { if ($line -ne "") { Write-Host ("    " + $line) } }

Write-Host "=== [5/6] Wait 40s (13s pre-delay + 12s timeout x2 + 3s margin) ===" -ForegroundColor Yellow
for ($i = 0; $i -lt 40; $i += 5) {
    Write-Host ("  elapsed " + $i + "s / 40s ...")
    Start-Sleep -Seconds 5
}

Write-Host "=== [6/6] Stop logcat ===" -ForegroundColor Yellow
try { Stop-Process -Id $logproc.Id -Force -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 1000

if (Test-Path $logpath) {
    $info = Get-Item $logpath
    $lines = (Get-Content $logpath).Count
    $mb = [math]::Round($info.Length / 1MB, 2)
    Write-Host ("Captured " + $lines + " lines (" + $mb + " MB) -> " + $logpath) -ForegroundColor Green
}

Write-Host ""
Write-Host "================== FILTERED LOG (RetroRadio + WebEngine + AUTO_v49 + ICY + console) ==================" -ForegroundColor Cyan
if (Test-Path $logpath) {
    $re = '(RetroRadio|WebEngine|AUTOv49|FINAL FAIL|attempt failed|Retrying once|IcyCleanProxy|handleClient|wrapUrlViaProxy|play promise|timeout 12s|audio onerror|hls fatal|proxy port|IcyCleanProxy port|playChannel|playUrl|reportMeta|MediaError|MEDIA_ERR|evaluateJavascript|DebugEvalReceiver|nativeRadio|dispatchJsEvent|chromium.*Console|chromium.*[Mm]edia|chromium.*[Aa]udio|chromium.*error|net::ERR_|Mixed Content|WebView.*console|ICY 200 OK|icy-metaint|127\.0\.0\.1|ConsoleMessage|INFO:CONSOLE|cr_package: com.retro.radio|AndroidRuntime|FATAL EXCEPTION)'
    $m = Get-Content $logpath | Select-String -Pattern $re
    if (-not $m) {
        Write-Host "(NO matches by regex - dumping last 180 raw lines)" -ForegroundColor Yellow
        Get-Content $logpath | Select-Object -Last 180
    } else {
        $rows = $m | ForEach-Object { $_.Line }
        Write-Host ("Found " + $rows.Count + " relevant lines, showing LAST 350:")
        Write-Host ""
        $rows | Select-Object -Last 350
    }
}

Write-Host ""
Write-Host ("DONE. Raw log saved to " + $logpath) -ForegroundColor Green
