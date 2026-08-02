$ErrorActionPreference = 'Continue'
$adb = 'd:\Trae Work\RetroRadioDesktop\mobile\android-sdk\platform-tools\adb.exe'
$target = 'adb-3B66170272200000-UlsokZ._adb-tls-connect._tcp'
$pkg = 'com.retro.radio'
$logpath = 'd:\Trae Work\RetroRadioDesktop\mobile\build\log_v48_repro.txt'

Write-Host '=== [1/5] logcat -c, start log capture ===' -ForegroundColor Yellow
& $adb -s $target logcat -c 2>&1 | Out-Null
$logproc = Start-Process -FilePath $adb -ArgumentList @("-s",$target,"logcat","-v","threadtime","-b","main,system,crash") `
  -RedirectStandardOutput $logpath -NoNewWindow -PassThru
Start-Sleep -Milliseconds 500

Write-Host '=== [2/5] Dismiss battery modal if open (KEYCODE_BACK x3) ===' -ForegroundColor Yellow
& $adb -s $target shell input keyevent KEYCODE_BACK 2>&1 | Out-Null
Start-Sleep -Milliseconds 400
& $adb -s $target shell input keyevent KEYCODE_BACK 2>&1 | Out-Null
Start-Sleep -Milliseconds 400
& $adb -s $target shell input keyevent KEYCODE_BACK 2>&1 | Out-Null
Start-Sleep -Milliseconds 400

Write-Host '=== [3/5] Bring retroradio to front + tap Taiwan area center screen ===' -ForegroundColor Yellow
& $adb -s $target shell monkey -p $pkg -c android.intent.category.LAUNCHER 1 2>&1 | Out-Null
Start-Sleep -Milliseconds 1500

Write-Host '=== [3b] Tap Taiwan (sidebar x=80 y=650) → tap 大千 row (x=540 y=1350) ===' -ForegroundColor Yellow
& $adb -s $target shell input tap 80 650 2>&1 | Out-Null
Start-Sleep -Milliseconds 900
Write-Host 'TAP 大千电台 row'
& $adb -s $target shell input tap 540 1350 2>&1 | Out-Null

Write-Host '=== [4/5] Wait 22s for play attempt (2x 12s timeout rounds) ===' -ForegroundColor Yellow
Start-Sleep -Seconds 22

Write-Host '=== [5/5] Kill logcat, then show filtered ===' -ForegroundColor Yellow
try { Stop-Process -Id $logproc.Id -Force -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 700

if (Test-Path $logpath) {
  $lines = (Get-Content $logpath).Count
  $mb = [math]::Round((Get-Item $logpath).Length / 1MB, 2)
  Write-Host "Captured $lines lines ($mb MB) → $logpath" -ForegroundColor Green
}
Write-Host ''
Write-Host '=== RELEVANT LOG last 180 lines ===' -ForegroundColor Cyan
if (Test-Path $logpath) {
  $re = '(RetroRadio|WebEngine|AUTO|chromium|WebView|AudioTrack|MediaPlayer|NuPlayer|CCodec|Playback|Icy|ICY|hls|MediaError|MEDIA_ERR|SHOUT|AudioFlinger|net::|ERR_|Mixed|ContentLoad|evaluateJavascript|proxy|PROXY|wrapUrlViaProxy|onCreate|handleClient|ICY 2|127\.0\.0\.1)'
  $m = Get-Content $logpath | Select-String -Pattern $re
  if (-not $m) {
    Write-Host '(no regex match; dump last 200 lines of log)' -ForegroundColor Yellow
    Get-Content $logpath | Select-Object -Last 200
  } else {
    $rows = $m | ForEach-Object { $_.Line } | Select-Object -Last 180
    Write-Host "Showing last $($rows.Count) lines:"
    Write-Host ''
    $rows
  }
}
Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
