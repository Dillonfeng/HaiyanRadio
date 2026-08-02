$ErrorActionPreference = 'Continue'
$adb = 'd:\Trae Work\RetroRadioDesktop\mobile\android-sdk\platform-tools\adb.exe'
$target = 'adb-3B66170272200000-UlsokZ._adb-tls-connect._tcp'
$apk = 'd:\Trae Work\RetroRadioDesktop\mobile\android\app\build\outputs\apk\debug\app-debug.apk'
$pkg = 'com.retro.radio'
$act = 'com.retro.radio.MainActivity'
$logpath = 'd:\Trae Work\RetroRadioDesktop\mobile\build\log_v48_repro.txt'

Write-Host '=== [1/7] Uninstall old ===' -ForegroundColor Yellow
& $adb -s $target uninstall $pkg 2>&1 | Out-Host

Write-Host '=== [2/7] Install v48 ===' -ForegroundColor Yellow
& $adb -s $target install -r -d $apk 2>&1 | Out-Host

Write-Host '=== [3/7] logcat -c (clear) ===' -ForegroundColor Yellow
& $adb -s $target logcat -c 2>&1 | Out-Host

Write-Host '=== [4/7] Start background logcat capture ===' -ForegroundColor Yellow
$logOut = 'd:\Trae Work\RetroRadioDesktop\mobile\build\logcat_v48.pipe'
try { New-Item -ItemType Directory -Force -Path (Split-Path $logpath) | Out-Null } catch {}
$logproc = Start-Process -FilePath $adb -ArgumentList @("-s",$target,"logcat","-v","threadtime","-b","main,system,crash") `
  -RedirectStandardOutput $logpath -NoNewWindow -PassThru

Start-Sleep -Milliseconds 800

Write-Host '=== [5/7] Cold start app ===' -ForegroundColor Yellow
& $adb -s $target shell am force-stop $pkg 2>&1 | Out-Null
Start-Sleep -Milliseconds 600
& $adb -s $target shell am start -S -W -n "$pkg/$act" 2>&1 | Select-Object -Last 5 | Out-Host

Write-Host '=== [6/7] Wait 6s, then inject JS to play 大千 ===' -ForegroundColor Yellow
Start-Sleep -Seconds 6

$trigger = @'
(function(){
  const all = (typeof state !== 'undefined' && state.channels && state.channels.radio)
    ? state.channels.radio.concat(state.channels.tv || []) : [];
  function f(k){ return all.find(function(c){ return c.name && c.name.indexOf(k)>=0; }); }
  const ch = f('大千') || f('FM99.1') || f('宝岛新聲') || f('良友') || f('光华') || all[0];
  if (!ch) { console.log('[AUTO] no channels'); return; }
  console.log('[AUTO] play '+ch.name+' url='+ch.url);
  if (window.els && els.fpStatus) els.fpStatus.textContent='AUTO v48: '+ch.name;
  setTimeout(function(){ playChannel(ch); }, 500);
})();
'@
$esc = $trigger -replace "'", "''"
Write-Host ('JS len=' + $esc.Length)
& $adb -s $target shell am broadcast -a com.retro.radio.DEBUG_EVAL_JS --es js $esc 2>&1 | Out-Host

Write-Host '=== [7/7] Wait 22s capture, then stop logcat ===' -ForegroundColor Yellow
Start-Sleep -Seconds 22

try { Stop-Process -Id $logproc.Id -Force -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 800

if (Test-Path $logpath) {
  $lines = (Get-Content $logpath).Count
  $mb = [math]::Round((Get-Item $logpath).Length / 1MB, 2)
  Write-Host "Captured $lines lines ($mb MB) → $logpath" -ForegroundColor Green
}

Write-Host ''
Write-Host '=== FILTERED last 150 relevant lines ===' -ForegroundColor Cyan
if (Test-Path $logpath) {
  $re = '(RetroRadio|WebEngine|AUTO-TEST|chromium|chromium_net|console|WebView|AudioTrack|MediaPlayer|NuPlayer|CCodec|Playback|Icy|ICY|hls|MediaError|MEDIA_ERR|SHOUT|AudioFlinger|net::|ERR_|CORS|Mixed|ContentLoad)'
  $m = Get-Content $logpath | Select-String -Pattern $re
  if (-not $m) {
    Write-Host '(no relevant match; dumping last 200 lines of full log)' -ForegroundColor Yellow
    Get-Content $logpath | Select-Object -Last 200
  } else {
    $rows = $m | ForEach-Object { $_.Line } | Select-Object -Last 150
    Write-Host "Showing last $($rows.Count) filtered lines:"
    Write-Host ''
    $rows
  }
}
Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
