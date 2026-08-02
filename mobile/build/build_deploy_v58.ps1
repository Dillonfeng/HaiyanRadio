$ErrorActionPreference = 'Stop'
$WorkingDir = 'D:\Trae Work\RetroRadioDesktop\mobile'
$AndroidDir = Join-Path $WorkingDir 'android'
$Gradle = Join-Path $AndroidDir 'gradlew.bat'
$Apk = Join-Path $AndroidDir 'app\build\outputs\apk\debug\app-debug.apk'
Push-Location $AndroidDir
try {
  Write-Host '=== [BUILD v58] assembleDebug ===' -ForegroundColor Cyan
  & $Gradle :app:assembleDebug 2>&1 | ForEach-Object { Write-Host ('  ' + $_) }
  if ($LASTEXITCODE -ne 0) { throw "gradle failed exit=$LASTEXITCODE" }
  $fi = Get-Item $Apk -ErrorAction Stop
  $sizeKB = [int]($fi.Length/1KB)
  Write-Host "=== [BUILD OK] size=${sizeKB}KB ===" -ForegroundColor Green

  $ADB = 'D:\Trae Work\RetroRadioDesktop\mobile\android-sdk\platform-tools\adb.exe'
  $ADB_HOST = '192.168.0.103:44293'
  $PKG = 'com.retro.radio'
  function A($a){ & $ADB -s $ADB_HOST @a 2>&1 }

  Write-Host "=== [DEPLOY] adb connect ${ADB_HOST} ===" -ForegroundColor Cyan
  A @('disconnect') | Out-Null
  Start-Sleep -Milliseconds 300
  $cr = A @('connect',$ADB_HOST)
  Write-Host "  -> $cr"
  Start-Sleep -Milliseconds 700
  $dev = A @('devices')
  Write-Host ($dev | Out-String)
  if (-not ($dev -match '\tdevice$')) { throw 'device not in device state' }

  Write-Host '=== [DEPLOY] install + perms + launch ===' -ForegroundColor Cyan
  A @('shell','am','force-stop',$PKG) | Out-Null
  Start-Sleep -Milliseconds 400
  A @('logcat','-c') | Out-Null
  Write-Host '  adb install -r v58 (1.3.58)'
  $ins = A @('install','-r',$Apk)
  Write-Host ($ins | ForEach-Object {"    $_"} | Out-String)
  if (-not ($ins -match 'Success')) { throw 'install failed' }
  Start-Sleep -Milliseconds 1500
  $perms = @('POST_NOTIFICATIONS','ACCESS_FINE_LOCATION','ACCESS_COARSE_LOCATION','FOREGROUND_SERVICE','FOREGROUND_SERVICE_MEDIA_PLAYBACK','WAKE_LOCK','INTERNET','ACCESS_NETWORK_STATE','ACCESS_WIFI_STATE')
  foreach ($p in $perms) {
    A @('shell','pm','grant',$PKG,"android.permission.$p") | Out-Null
  }
  A @('shell','dumpsys','deviceidle','whitelist','+',$PKG) | Out-Null
  Write-Host '  [OK] permissions + battery whitelist' -ForegroundColor Green
  A @('shell','input','keyevent','KEYCODE_WAKEUP') | Out-Null
  Start-Sleep -Milliseconds 300
  A @('shell','input','swipe','530','2000','530','600','200') | Out-Null
  Start-Sleep -Milliseconds 300
  A @('shell','settings','put','global','stay_on_while_plugged_in','7') | Out-Null
  A @('shell','am','start','-n','com.retro.radio/.MainActivity','-a','android.intent.action.MAIN','-c','android.intent.category.LAUNCHER') | Out-Null

  Write-Host '=== [DONE] v58 DEPLOYED (versionCode=58 / 1.3.58) ===' -ForegroundColor Green
  Write-Host ''
  Write-Host '  FIX: HTTPS HLS (jjzs / ngcdn002.cnr.cn) -> use hls.js on Android too (no mixed content)'
  Write-Host '  FIX: HTTP  HLS (ghzs / cri 905)    -> Chromium native <audio src=m3u8> (no hls.js XHR block)'
  Write-Host '  FIX: HTTP  MP3 (daqian FM99.1)     -> direct audio.src, NO crossorigin (no CORS preflight kill)'
  Write-Host '  FIX: Global: onAudioFocusChange(LOSS_TRANSIENT) no longer sends ACTION_PAUSE -> no 1-word self-interrupt'
  Write-Host ''
  Write-Host '  Please tap cards: r47(huanqiu) -> r130(jjzs) -> bk105(daqian) -> bk67(guanghua)'
} finally {
  Pop-Location
}
