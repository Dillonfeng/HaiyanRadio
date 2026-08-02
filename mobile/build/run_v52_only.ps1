$ErrorActionPreference = 'Continue'
$adb = 'd:\Trae Work\RetroRadioDesktop\mobile\android-sdk\platform-tools\adb.exe'
$t = 'adb-3B66170272200000-UlsokZ._adb-tls-connect._tcp'
$pkg = 'com.retro.radio'
$act = 'com.retro.radio.MainActivity'
$log = 'd:\Trae Work\RetroRadioDesktop\mobile\build\log_v52_full.txt'

Write-Host "=== Device alive check ===" -ForegroundColor Yellow
$st = (& $adb -s $t get-state)
Write-Host "  get-state: $st"
if ($st -notmatch 'device$') {
    Write-Host "  device offline, attempting reconnect" -ForegroundColor Yellow
    & $adb kill-server 2>$null | Out-Null ; Start-Sleep -Seconds 1
    & $adb start-server 2>$null | Out-Null ; Start-Sleep -Seconds 4
}

Write-Host "=== Clear old log + start log capture ===" -ForegroundColor Yellow
if (Test-Path $log) { Remove-Item -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 200
& $adb -s $t logcat -c -b all 2>$null | Out-Null
Start-Sleep -Milliseconds 500

$adbExe = 'cmd.exe'
$adbArgs = '/C "' + $adb.Replace('\','\\') + '" -s "' + $t + '" logcat -b all -v threadtime > "' + $log + '"'
$logproc = Start-Process -FilePath $adbExe -ArgumentList $adbArgs -PassThru -WindowStyle Hidden
Write-Host "  logproc id=$($logproc.Id)"
Start-Sleep -Seconds 2
Write-Host "  logproc alive=$(-not $logproc.HasExited)"
for ($i = 0; $i -lt 6; $i++) {
    Start-Sleep -Milliseconds 500
    $kb = 0
    if (Test-Path $log) { try { $kb = [math]::Round((Get-Item $log).Length/1KB, 1) } catch {} }
    Write-Host "  probe $i alive=$(-not $logproc.HasExited) logsize=${kb}KB"
}

Write-Host "=== Permissions + dismiss dialogs ===" -ForegroundColor Yellow
@('android.permission.POST_NOTIFICATIONS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.WAKE_LOCK') | ForEach-Object {
    & $adb -s $t shell pm grant $pkg $_ 2>$null | Out-Null
}
& $adb -s $t shell settings put global stay_on_while_plugged_in 7 2>$null | Out-Null
& $adb -s $t shell svc power stayon true 2>$null | Out-Null
& $adb -s $t shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS 2>$null | Out-Null
for ($i=0; $i -lt 5; $i++) { & $adb -s $t shell input keyevent KEYCODE_BACK 2>$null | Out-Null ; Start-Sleep -Milliseconds 200 }

Write-Host "=== Cold launch app ===" -ForegroundColor Yellow
& $adb -s $t shell am force-stop $pkg 2>$null | Out-Null
Start-Sleep -Milliseconds 700
$startOut = (& $adb -s $t shell am start -S -W -n "${pkg}/${act}" 2>&1)
$startOut | Select-Object -First 5 | ForEach-Object { Write-Host "  start: $_" }
Start-Sleep -Seconds 2
for ($i=0; $i -lt 4; $i++) { & $adb -s $t shell input keyevent KEYCODE_BACK 2>$null | Out-Null ; Start-Sleep -Milliseconds 250 }

Write-Host "=== Wait 80s (T+12s大千, T+28s宝岛, T+60s final, +20s audio buffer) ===" -ForegroundColor Yellow
for ($i=0; $i -lt 80; $i+=5) {
    $kb = 0
    if (Test-Path $log) { try { $kb = [math]::Round((Get-Item $log).Length/1KB, 1) } catch {} }
    Write-Host ("  {0,3}s / 80s   alive={1}   {2}KB" -f $i, (-not $logproc.HasExited), $kb)
    Start-Sleep -Seconds 5
}

Write-Host "=== Stop logcat ===" -ForegroundColor Yellow
try { if (-not $logproc.HasExited) { Stop-Process -Id $logproc.Id -Force -ErrorAction SilentlyContinue } } catch {}
Start-Sleep -Milliseconds 1200

if (Test-Path $log) {
    $szMB = [math]::Round((Get-Item $log).Length/1MB, 2)
    $lc = (Get-Content $log).Count
    Write-Host "  LOG OK lines=$lc size=${szMB}MB -> $log" -ForegroundColor Green
}

Write-Host ""
Write-Host "==================== FILTERED v52 PLAYBACK LOG ====================" -ForegroundColor Cyan
$regex = '(RetroRadio|WebEngine|AUTOv|FINAL FAIL|attempt failed|Retrying once|onplaying OK|stale seq|post-wait retry|ignore this STOP|handleClient FAIL|play promise|timeout 12s|audio onerror|hls fatal|playChannel|seq=.*SKIP|reportMeta|MediaError|MEDIA_ERR|nativeRadio event=|INFO:CONSOLE|FATAL EXCEPTION|oncanplay|onloadeddata|nativeRadio\] on play|nativeRadio\] on pause|nativeRadio\] on stop|internal state update only|SKIP \(either)'
$matches = Get-Content $log | Select-String -Pattern $regex
$rows = @($matches | ForEach-Object { $_.Line })
Write-Host "  regex hits=$($rows.Count)"
Write-Host ""
$rows | Select-Object -Last 1000

Write-Host ""
Write-Host "[FINISH] LOG: $log" -ForegroundColor Green
