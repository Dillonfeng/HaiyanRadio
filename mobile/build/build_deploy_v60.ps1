$ErrorActionPreference = 'Continue'
$WorkingDir = 'D:\Trae Work\RetroRadioDesktop\mobile'
$AndroidDir = Join-Path $WorkingDir 'android'
$Gradle = Join-Path $AndroidDir 'gradlew.bat'
$Apk = Join-Path $AndroidDir 'app\build\outputs\apk\debug\app-debug.apk'
Push-Location $AndroidDir
try {
  Write-Host '=== [1/4] BUILD v60 assembleDebug ===' -ForegroundColor Cyan
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

  Write-Host '=== [4/4] install + perms + launch v60 (1.3.60, code 60) ===' -ForegroundColor Cyan
  A @('shell','am','force-stop',$PKG) | Out-Null; Start-Sleep -Milliseconds 400
  A @('logcat','-c') | Out-Null
  Write-Host '  adb install -r (v60)...'
  $ins = A @('install','-r',$Apk)
  Write-Host ($ins | ForEach-Object {"    $_"} | Out-String)
  Start-Sleep -Milliseconds 1500
  $perms = @('POST_NOTIFICATIONS','ACCESS_FINE_LOCATION','ACCESS_COARSE_LOCATION','FOREGROUND_SERVICE','FOREGROUND_SERVICE_MEDIA_PLAYBACK','WAKE_LOCK','INTERNET','ACCESS_NETWORK_STATE','ACCESS_WIFI_STATE')
  foreach ($p in $perms) { $null = A @('shell','pm','grant',$PKG,"android.permission.$p") }
  $null = A @('shell','dumpsys','deviceidle','whitelist','+',$PKG)
  Write-Host '  perms + battery whitelist OK' -ForegroundColor Green
  $null = A @('shell','input','keyevent','KEYCODE_WAKEUP'); Start-Sleep -Milliseconds 300
  $null = A @('shell','input','swipe','530','2000','530','600','200'); Start-Sleep -Milliseconds 300
  $null = A @('shell','settings','put','global','stay_on_while_plugged_in','7')
  $null = A @('shell','am','start','-n','com.retro.radio/.MainActivity','-a','android.intent.action.MAIN','-c','android.intent.category.LAUNCHER')
  Write-Host '=== DONE v60 DEPLOYED (versionCode=60 / 1.3.60) ===' -ForegroundColor Green
  Write-Host ''
  Write-Host '  v60 fixes:'
  Write-Host '   1. DATA_VERSION=60 => force reset radio_channels localStorage cache'
  Write-Host '      -> Mobile 中央分组 WILL have 故城县经典音乐 now (matches Electron)'
  Write-Host '   2. JJZS (HTTPS m3u8) hls.js: use IF LIBRARY EXISTS (typeof Hls!=undefined),'
  Write-Host '      ignore OPPOs misreported Hls.isSupported() false (which was causing'
  Write-Host '      direct-native play() to fail immediately w/ AbortError/NotSupportedError).'
  Write-Host '      hls.js fail -> auto fallback to native <audio src=m3u8> as before.'
  Write-Host '   3. direct-native helper: OPPO HTTPS HLS first play() often rejects immediately.'
  Write-Host '      Before, we showed toast. NOW: audio.load() + retry play once (350ms).'
  Write-Host '      Only SECOND failure shows the toast (matches Electron robustness).'
  Write-Host '   4. MainActivity: wv.setWebChromeClient() overrides onConsoleMessage ->'
  Write-Host '      EVERYTHING console.log-ed becomes Log.d(RetroRadioWebConsole).'
  Write-Host '      From now on, adb logcat -s RetroRadioWebConsole RetroRadioMain shows'
  Write-Host '      the full [WebEngine] pipeline (no more blind debugging!)'
  Write-Host '   5. Kept v57 core fix: LOSS_TRANSIENT AudioFocus no longer self-pauses.'
  Write-Host '      Kept v56: no crossorigin for 大千电台 (HTTP ICY), HTTP m3u8=native (no Mixed).'
  Write-Host ''
  Write-Host '  Please tap cards and report: r47, r130(jjzs), bk105, bk67. Thanks!'
} finally {
  Pop-Location
}
