$ErrorActionPreference = 'Continue'
$adb = 'd:\Trae Work\RetroRadioDesktop\mobile\android-sdk\platform-tools\adb.exe'
$target = 'adb-3B66170272200000-UlsokZ._adb-tls-connect._tcp'
$pkg = 'com.retro.radio'
$act = 'com.retro.radio.MainActivity'
$apkPath = 'd:\Trae Work\RetroRadioDesktop\mobile\android\app\build\outputs\apk\debug\app-debug.apk'
$logpath = 'd:\Trae Work\RetroRadioDesktop\mobile\build\log_v49_full.txt'
$jsOnDevice = '/data/local/tmp/dbg_v49.js'

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

Write-Host "=== [1/9] Uninstall old APK ===" -ForegroundColor Yellow
$r = Run-Adb @('uninstall', $pkg)
Write-Host "  uninstall: $($r.Out) $($r.Err)"

Write-Host "=== [2/9] Install v49 APK ===" -ForegroundColor Yellow
$r = Run-Adb @('install', '-r', '-d', $apkPath)
Write-Host "  install: exit=$($r.ExitCode)"
if ($r.Out) { Write-Host "  $($r.Out)" }
if ($r.Err -match 'Failure|INSTALL_FAILED|not found|adb: failed') {
    Write-Host "  ERR: $($r.Err)" -ForegroundColor Red
    Write-Host "  Trying push+pm fallback..." -ForegroundColor Yellow
    Run-Adb @('shell', 'rm', '/data/local/tmp/retroradio.apk') | Out-Null
    $rp = Run-Adb @('push', $apkPath, '/data/local/tmp/retroradio.apk')
    Write-Host "  push: $($rp.Out)"
    $ri = Run-Adb @('shell', 'pm', 'install', '-r', '-d', '/data/local/tmp/retroradio.apk')
    Write-Host "  pm install: exit=$($ri.ExitCode) $($ri.Out) $($ri.Err)"
}

Write-Host "=== [3/9] Write JS helper file to device (avoids shell quote escaping) ===" -ForegroundColor Yellow
$jsLocal = Join-Path $env:TEMP "dbg_v49_$(Get-Random).js"
@'
(function(){
  try {
    console.log("[AUTO_v49] step1: define target");
    var t = {id:"bk105", name:"Daqian FM99.1", frequency:"FM99.1",
      url:"http://125.227.87.206:8000/FM99.1",
      description:"TW", category:"news", color:"#4a90e2", logo:""};
    window.__dbgCh = t;
    console.log("[AUTO_v49] target url=" + t.url);
    var hasPC = typeof playChannel === "function";
    console.log("[AUTO_v49] playChannel exists? " + hasPC);
    if (hasPC) {
      console.log("[AUTO_v49] CALLING playChannel");
      playChannel(t);
      console.log("[AUTO_v49] playChannel returned");
    } else {
      console.log("[AUTO_v49] ERROR no playChannel function");
    }
    return "ok-step1";
  } catch(e) {
    console.error("[AUTO_v49] step1 EXC: " + e.message);
    return "err:" + e.message;
  }
})();
'@ | Set-Content -Path $jsLocal -Encoding ASCII
Run-Adb @('push', $jsLocal, $jsOnDevice) | Out-Null
Remove-Item $jsLocal -ErrorAction SilentlyContinue

Write-Host "=== [4/9] logcat -c + start capture ===" -ForegroundColor Yellow
Run-Adb @('logcat', '-c') | Out-Null
Start-Sleep -Milliseconds 300
$logproc = Start-Process -FilePath $adb -ArgumentList @('-s', $target, 'logcat', '-v', 'threadtime', '-b', 'main,system,crash,webview') `
    -RedirectStandardOutput $logpath -NoNewWindow -PassThru
Start-Sleep -Milliseconds 800

Write-Host "=== [5/9] Force stop + cold launch app ===" -ForegroundColor Yellow
Run-Adb @('shell', 'am', 'force-stop', $pkg) | Out-Null
Start-Sleep -Milliseconds 600
$r = Run-Adb @('shell', 'am', 'start', '-S', '-W', '-n', "$pkg/$act")
Write-Host "  launch: $($r.Out | Select-Object -First 5)"

Write-Host "=== [6/9] Wait 11s for app init + render ===" -ForegroundColor Yellow
Start-Sleep -Seconds 11

Write-Host "=== [7/9] Inject JS via broadcast: cat jsOnDevice into shell variable + am broadcast ===" -ForegroundColor Yellow
$shellCmd = "JS=`$(cat $jsOnDevice | tr -d '\r')`; am broadcast -a com.retro.radio.DEBUG_EVAL_JS --es js `"`$JS`""
$r = Run-Adb @('shell', '-n', $shellCmd)
Write-Host "  shell+broadcast exit=$($r.ExitCode)"
if ($r.Out) { Write-Host "  $($r.Out)" }
if ($r.Err) { Write-Host "  stderr: $($r.Err)" }

Write-Host "  fallback: also try simpler short broadcast (in case file-read method had quote issues)"
Start-Sleep -Milliseconds 600
$short = 'console.log("[AUTO_v49_short] calling"); if (window.__dbgCh && typeof playChannel === "function") { playChannel(window.__dbgCh); console.log("[AUTO_v49_short] ok"); } else { console.log("[AUTO_v49_short] missing: pc=" + (typeof playChannel) + " ch=" + (!!window.__dbgCh)); }'
$r2 = Run-Adb @('shell', 'am', 'broadcast', '-a', 'com.retro.radio.DEBUG_EVAL_JS', '--es', 'js', $short)
Write-Host "  short-broadcast exit=$($r2.ExitCode) out=$($r2.Out)"

Write-Host "=== [8/9] Wait 28s for 2x12s timeout rounds ===" -ForegroundColor Yellow
for ($i = 0; $i -lt 28; $i += 4) {
    Write-Host "  waiting... ${i}s/28s"
    Start-Sleep -Seconds 4
}

Write-Host "=== [9/9] Kill logcat process ===" -ForegroundColor Yellow
try { Stop-Process -Id $logproc.Id -Force -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 900

if (Test-Path $logpath) {
    $lines = (Get-Content $logpath).Count
    $mb = [math]::Round((Get-Item $logpath).Length / 1MB, 2)
    Write-Host "Captured $lines lines ($mb MB) -> $logpath" -ForegroundColor Green
}

Write-Host ""
Write-Host "================== FILTERED LOG (RetroRadio + WebEngine + ICY + AUTO_v49) ==================" -ForegroundColor Cyan
if (Test-Path $logpath) {
    $re = '(RetroRadio|WebEngine|AUTO_v49|FINAL FAIL|attempt failed|Retrying once|IcyCleanProxy|handleClient|wrapUrlViaProxy|play promise|timeout 12s|audio onerror|hls fatal|proxy port|IcyCleanProxy port|playChannel|playUrl|reportMeta|MediaError|MEDIA_ERR|evaluateJavascript|DebugEvalReceiver|nativeRadio|dispatchJsEvent|chromium.*[Mm]edia|chromium.*[Aa]udio|chromium.*error|net::ERR_|Mixed Content|WebView.*console|ICY 200 OK|icy-metaint|127\.0\.0\.1)'
    $m = Get-Content $logpath | Select-String -Pattern $re
    if (-not $m) {
        Write-Host '(NO RetroRadio/WebEngine logs - checking app start/crash)' -ForegroundColor Yellow
        $m2 = Get-Content $logpath | Select-String -Pattern '(FATAL EXCEPTION|AndroidRuntime|com\.retro\.radio|E/Retro|WebView.*load|onCreate|capacitor|SystemWebView|Console)'
        if ($m2) { $m2 | ForEach-Object { $_.Line } | Select-Object -Last 200 }
        else { Get-Content $logpath | Select-Object -Last 100 }
    } else {
        $rows = $m | ForEach-Object { $_.Line }
        Write-Host "Found $($rows.Count) relevant lines (last 300):"
        Write-Host ""
        $rows | Select-Object -Last 300
    }
}

Write-Host ""
Write-Host "DONE. Log file: $logpath" -ForegroundColor Green
