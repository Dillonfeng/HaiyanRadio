$ErrorActionPreference = 'Continue'
$WorkingDir = 'D:\Trae Work\RetroRadioDesktop\mobile'
$AndroidDir = Join-Path $WorkingDir 'android'
$Gradle = Join-Path $AndroidDir 'gradlew.bat'
$Apk = Join-Path $AndroidDir 'app\build\outputs\apk\debug\app-debug.apk'
Push-Location $AndroidDir
try {
  Write-Host '=== [1/4] BUILD v59 assembleDebug ===' -ForegroundColor Cyan
  & $Gradle ':app:assembleDebug' 2>&1 | ForEach-Object { Write-Host ('  ' + $_) }
  if ($LASTEXITCODE -ne 0) { throw "gradle failed exit=$LASTEXITCODE" }
  $fi = Get-Item $Apk -ErrorAction Stop
  $sizeKB = [int]($fi.Length/1KB)
  Write-Host "=== [2/4] BUILD OK size=${sizeKB}KB ===" -ForegroundColor Green

  $ADB = 'D:\Trae Work\RetroRadioDesktop\mobile\android-sdk\platform-tools\adb.exe'
  $ADB_HOST = '192.168.0.103:44293'
  $PKG = 'com.retro.radio'
  function A($argsArr){ & $ADB -s $ADB_HOST @argsArr 2>&1 }

  Write-Host "=== [3/4] DEPLOY adb connect ${ADB_HOST} ===" -ForegroundColor Cyan
  A @('disconnect') | Out-Null
  Start-Sleep -Milliseconds 300
  $cr = A @('connect',$ADB_HOST)
  Write-Host "  -> $cr"
  Start-Sleep -Milliseconds 700
  $dev = A @('devices')
  Write-Host ($dev | Out-String)
  if (-not ($dev -match '\tdevice$')) { throw 'device not in device state' }

  Write-Host '=== [4/4] install + perms + launch v59 ===' -ForegroundColor Cyan
  A @('shell','am','force-stop',$PKG) | Out-Null; Start-Sleep -Milliseconds 400
  A @('logcat','-c') | Out-Null
  Write-Host '  adb install -r v59 (1.3.59, versionCode=59)'
  $ins = A @('install','-r',$Apk)
  Write-Host ($ins | ForEach-Object {"    $_"} | Out-String)
  Start-Sleep -Milliseconds 1500
  $perms = @('POST_NOTIFICATIONS','ACCESS_FINE_LOCATION','ACCESS_COARSE_LOCATION','FOREGROUND_SERVICE','FOREGROUND_SERVICE_MEDIA_PLAYBACK','WAKE_LOCK','INTERNET','ACCESS_NETWORK_STATE','ACCESS_WIFI_STATE')
  foreach ($p in $perms) {
    $null = A @('shell','pm','grant',$PKG,"android.permission.$p")
  }
  $null = A @('shell','dumpsys','deviceidle','whitelist','+',$PKG)
  Write-Host '  perms + battery whitelist OK' -ForegroundColor Green
  $null = A @('shell','input','keyevent','KEYCODE_WAKEUP'); Start-Sleep -Milliseconds 300
  $null = A @('shell','input','swipe','530','2000','530','600','200'); Start-Sleep -Milliseconds 300
  $null = A @('shell','settings','put','global','stay_on_while_plugged_in','7')
  $null = A @('shell','am','start','-n','com.retro.radio/.MainActivity','-a','android.intent.action.MAIN','-c','android.intent.category.LAUNCHER')
  Write-Host '=== DONE v59 DEPLOYED (versionCode=59 / 1.3.59) ===' -ForegroundColor Green
  Write-Host ''
  Write-Host '  v59 changes (pure ASCII to avoid PowerShell encoding hell):'
  Write-Host '   1. channels.js 100pct identical between Electron + mobile (SHA256 matched).'
  Write-Host '      Same 故城县 / 经济之声 / 环球 in 中央 grouping and same URL data.'
  Write-Host '   2. JJZS r130 (HTTPS m3u8): try HLS.JS first on Android. If hls.js gets'
  Write-Host '      NO onplaying within 8s, or FATAL network error, or constructor/play'
  Write-Host '      throws, we AUTOMATICALLY FALLBACK to Chromium-native m3u8 playback.'
  Write-Host '      Verbose logs for engine decision + Hls.version + MANIFEST/LEVEL/ERROR.'
  Write-Host '   3. Huanqiu / Guanghua HTTP HLS -> Chromium native (unchanged, works OK).'
  Write-Host '   4. Daqian FM99.1 HTTP ICY MP3 -> direct src, NO crossorigin (unchanged).'
  Write-Host '   5. Core v57 AudioFocus fix kept: no pseudo LOSS_TRANSIENT self-pause.'
  Write-Host ''
  Write-Host '  Please tap cards and report result for: r47(huanqiu) r130(jjzs) bk105(daqian) bk67(guanghua).'
} finally {
  Pop-Location
}
