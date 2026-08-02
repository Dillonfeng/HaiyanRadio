$ErrorActionPreference = 'Stop'
$ROOT     = "D:\Trae Work\RetroRadioDesktop\mobile"
$ADB      = "$ROOT\android-sdk\platform-tools\adb.exe"
$DEV      = "192.168.2.116:37713"
$PKG      = "com.retro.radio"
$APK      = "$ROOT\android\app\build\outputs\apk\release\app-release.apk"
$LOG      = "$ROOT\build\build_v61.log"

function A($args1) { & $ADB -s $DEV @args1 2>&1 }

Write-Host "=== [1/5] BUILD APK v1.3.61 (code=61) ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Split-Path $LOG) | Out-Null
Push-Location "$ROOT\android"
try {
    & .\gradlew.bat assembleRelease --no-daemon 2>&1 | Tee-Object -FilePath $LOG | Select-Object -Last 30
    if ($LASTEXITCODE -ne 0) { throw "gradlew assembleRelease failed exit=$LASTEXITCODE" }
} finally { Pop-Location }

if (-not (Test-Path $APK)) { throw "APK NOT FOUND at $APK" }
$szKB = [math]::Round((Get-Item $APK).Length / 1KB, 0)
Write-Host "   ✅ APK BUILT: $APK  size=${szKB}KB" -ForegroundColor Green

Write-Host "=== [2/5] INSTALL TO $DEV (NEW CORRECT IP, 192.168.2.*) ===" -ForegroundColor Green
A @('install','-r','-d', $APK) | Select-Object -Last 6
Start-Sleep -Milliseconds 900

Write-Host "=== [3/5] VERIFY versionCode EXPECTED=61 ===" -ForegroundColor Cyan
$pk = A @('shell','dumpsys','package',$PKG) |
      Select-String -Pattern 'versionCode|versionName|lastUpdateTime' |
      ForEach-Object { $_.ToString().Trim() }
Write-Host "   Current APK package info:"
$pk | ForEach-Object { Write-Host "     -> $_" }
$is61 = ($pk -join "`n") -match 'versionCode=61\b'
if (-not $is61) { Write-Host "   ❌ versionCode is NOT 61!" -ForegroundColor Red }
else            { Write-Host "   ✅ versionCode=61 VERIFIED ON DEVICE" -ForegroundColor Green }

Write-Host "=== [4/5] KILL OLD + LAUNCH APP ===" -ForegroundColor Green
A @('shell','am','force-stop', $PKG) | Out-Null
Start-Sleep -Milliseconds 400
A @('shell','am','start','-n','com.retro.radio/.MainActivity') | Select-Object -Last 3
Start-Sleep -Seconds 4

Write-Host "=== [5/5] FINISHED. 4 PROOFS FOR USER TO VERIFY DEPLOYMENT: ===" -ForegroundColor Yellow
Write-Host "   [A] TOP BAR: clock right -> RED BADGE with text: 'V61 JJZS'"
Write-Host "   [B] LAUNCH TOAST (4s): 'APP v1.3.61 (build61 JJZS)'"
Write-Host "   [C] LEFT SIDE -> 中央 category list -> contains '故城县经典音乐FM98.5'"
Write-Host "   [D] TAP ANY station card -> toast immediately shows '[v1.3.61 (build61 JJZS)] 播放 xxx'"
Write-Host ""
Write-Host "After user confirms A+B+C+D -> tap 经济之声, then run:"
Write-Host "   & '$ADB' -s $DEV logcat -s RetroRadioWebConsole RetroRadioMain -d -t 2000"
