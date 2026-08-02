$ErrorActionPreference = "Continue"

function Find-Adb {
    $candidates = @(
        "$PSScriptRoot\android-sdk\platform-tools\adb.exe",
        "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
        "$env:USERPROFILE\AppData\Local\Android\Sdk\platform-tools\adb.exe",
        "C:\Android\platform-tools\adb.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return (Resolve-Path $c).Path } }
    $cmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Invoke-Adb {
    param([string]$Adb, [string[]]$ArgList)

    $outTmp = Join-Path $env:TEMP ("adb_out_" + [guid]::NewGuid().ToString("N") + ".txt")
    $errTmp = Join-Path $env:TEMP ("adb_err_" + [guid]::NewGuid().ToString("N") + ".txt")
    try {
        $escaped = @()
        foreach ($a in $ArgList) {
            if ($a -match '[\s"]') { $escaped += '"' + ($a -replace '"', '\"') + '"' }
            else { $escaped += $a }
        }
        $argStr = $escaped -join " "
        $p = Start-Process -FilePath $Adb `
                           -ArgumentList $argStr `
                           -RedirectStandardOutput $outTmp `
                           -RedirectStandardError $errTmp `
                           -NoNewWindow -Wait -PassThru
        $out = if (Test-Path $outTmp) { Get-Content $outTmp -Raw } else { "" }
        $err = if (Test-Path $errTmp) { Get-Content $errTmp -Raw } else { "" }
    } finally {
        Remove-Item $outTmp -ErrorAction SilentlyContinue
        Remove-Item $errTmp -ErrorAction SilentlyContinue
    }

    $outAll = @()
    foreach ($L in ($out -split "`r?`n")) { if ($L -ne "") { $outAll += $L } }
    $errAll = @()
    foreach ($L in ($err -split "`r?`n")) { if ($L -ne "") { $errAll += $L } }

    return [pscustomobject]@{
        ExitCode    = $p.ExitCode
        RawOut      = $out
        RawErr      = $err
        OutputLines = $outAll
        ErrorLines  = $errAll
    }
}

function Line([string]$m, [ConsoleColor]$c=[ConsoleColor]::Gray) { Write-Host ("  " + $m) -ForegroundColor $c }
function Ok  ([string]$m) { Line $m ([ConsoleColor]::Green) }
function Warn([string]$m) { Line ("! " + $m) ([ConsoleColor]::Yellow) }
function Fail([string]$m) { Line ("X " + $m) ([ConsoleColor]::Red) }
function Hdr ([string]$m) { Write-Host ("=== " + $m + " ===") -ForegroundColor Cyan }

function List-Devices {
    param([string]$Adb)
    $result = @()
    try {
        $raw = cmd /c "`"$Adb`" devices" 2`>`&1
        foreach ($L in ($raw | Out-String) -split "`r?`n") {
            if ($L -match "List of devices attached|^\s*$") { continue }
            $parts = $L -split "\s+", 2
            if ($parts.Count -ge 2 -and $parts[1] -match "device") { $result += $parts[0] }
        }
    } catch {}
    return $result
}

$adb     = Find-Adb
$apkPath = "$PSScriptRoot\android\app\build\outputs\apk\debug\app-debug.apk"
$pkg     = "com.retro.radio"
$act     = "com.retro.radio.MainActivity"

Write-Host ""
Hdr "Retro Radio One-Click Deploy"
Write-Host ""

if (-not $adb) {
    Fail "adb.exe not found. Install one of:"
    Line "(A) Android Studio -> SDK Manager -> SDK Tools -> Android SDK Platform-Tools"
    Line "(B) Standalone: https://developer.android.com/tools/releases/platform-tools"
    Line ("    Extract platform-tools/ to: " + $PSScriptRoot + "\android-sdk\")
    exit 1
}

Line "Adb path: $adb"
Line "Ensuring adb server is running (NOT killing - preserves wireless connections) ..."
try {
    $job2 = Start-Job -ScriptBlock { param($adbPath) & $adbPath start-server 2>&1 | Out-Null } -ArgumentList $adb
    if ($job2) { Wait-Job $job2 -Timeout 4 | Out-Null ; Stop-Job $job2 -ErrorAction SilentlyContinue ; Remove-Job $job2 -Force -ErrorAction SilentlyContinue }
} catch {}
Start-Sleep -Milliseconds 300

# Simple version check (no complex redirections)
$vLine = $null
for ($i = 0; $i -lt 4 -and -not $vLine; $i++) {
    try {
        $vOut = cmd /c "`"$adb`" version" 2`>`&1
        foreach ($L in ($vOut | Out-String) -split "`r?`n") {
            if ($L -match "Android Debug Bridge|^Version \d") { $vLine = $L.Trim() ; break }
        }
    } catch {}
    if (-not $vLine) { Start-Sleep -Milliseconds 300 }
}
if ($vLine) { Ok ("Adb ready: " + $vLine) }
else { Warn "Adb version not detected (will continue - if install fails, run manually: adb devices)" }
Write-Host ""

$devices = @(List-Devices -Adb $adb)

# --- Load last saved wireless connection (IP:port) ---
$savedConnFile = Join-Path $PSScriptRoot ".last_adb_wifi_conn"
$lastConn = $null
if (Test-Path $savedConnFile) {
    try { $lastConn = (Get-Content $savedConnFile -Raw).Trim() } catch { $lastConn = $null }
}

if ($devices.Count -eq 0 -and $lastConn) {
    Line ("No live devices. Trying last saved wireless connection: " + $lastConn + " ...")
    try {
        $cRaw = cmd /c "`"$adb`" connect `"$lastConn`"" 2`>`&1
        $cJoined = ($cRaw | Out-String).Trim()
        if ($cJoined) { foreach ($L in ($cJoined -split "`r?`n")) { Line ("    | " + $L) } }
    } catch {}
    Start-Sleep -Milliseconds 1200
    $devices = @(List-Devices -Adb $adb)
    if ($devices.Count -gt 0) {
        Ok ("Auto-reconnected to saved device: " + $lastConn)
        Write-Host ""
    } else {
        Warn ("  Saved address " + $lastConn + " no longer reachable (phone IP changed / wireless debugging off).")
    }
}

if ($devices.Count -eq 0) {
    Warn "No connected devices."
    Write-Host ""
    Write-Host " Wireless Debugging on OPPO Reno14:" -ForegroundColor White
    Line "1. Settings -> About phone -> Version -> tap Version 7 times (unlock Developer options)."
    Line "2. Settings -> Additional settings -> Developer options -> Wireless debugging = ON."
    Line "3. Tap 'Wireless debugging' entry -> Tap 'Pair device with pairing code' -> STAY on this popup."
    Write-Host ""

    $pairIp   = Read-Host " [1/2] Pairing IP:port (from popup, example 192.168.1.8:39175, press Enter to skip if already paired before)"
    if ($pairIp) {
        $pairCode = Read-Host " [1/2] Pairing 6-digit code"
        Write-Host ""
        Line ("Pairing to $pairIp with code ...")
        try {
            $pairRaw = cmd /c "`"$adb`" pair `"$pairIp`" `"$pairCode`"" 2`>`&1
            $joined = ($pairRaw | Out-String).Trim()
            if ($joined) {
                Line "  adb pair response:"
                foreach ($L in ($joined -split "`r?`n")) { Line ("    | " + $L) }
            }
            if ($joined -match "Successfully paired|already paired|^Paired|Pairing successful") {
                Write-Host ""
                Write-Host "  >>> PAIR SUCCESS <<<" -ForegroundColor Green
                Write-Host ""
            } else {
                Warn "  Pair result not confirmed. If phone shows 'Paired devices count: 1', continue anyway."
                Write-Host ""
            }
        } catch {
            Warn ("  pair failed: " + $_.Exception.Message)
        }
    } else {
        Line "Pairing skipped. (USB cable users: on phone, tap 'Always allow' and OK.)"
        Write-Host ""
    }

    Write-Host " IMPORTANT: Go back to the MAIN Wireless Debugging page (exit pairing popup)." -ForegroundColor Yellow
    Write-Host "            At the top, line 'IP address and port' - this is the CONNECTION port (different from pairing)." -ForegroundColor Yellow
    Write-Host ""
    $defaultHint = if ($lastConn) { " (last used: $lastConn)" } else { "" }
    $ipPort = Read-Host " [2/2] Connection IP:port (example 192.168.1.8:32871)$defaultHint"
    if (-not $ipPort -and $lastConn) { $ipPort = $lastConn }
    if (-not $ipPort) { Warn "Cancelled."; exit 0 }
    Line ("Connecting to $ipPort ...")
    try {
        $cRaw = cmd /c "`"$adb`" connect `"$ipPort`"" 2`>`&1
        $cJoined = ($cRaw | Out-String).Trim()
        if ($cJoined) { foreach ($L in ($cJoined -split "`r?`n")) { Line ("    | " + $L) } }
    } catch {}
    Start-Sleep -Milliseconds 1400
    $devices = @(List-Devices -Adb $adb)
    if ($devices.Count -eq 0) {
        Fail "Connect failed. Use MAIN Wireless Debugging page port (NOT pairing popup port)."
        exit 1
    }
    try { Set-Content -Path $savedConnFile -Value $ipPort -Encoding utf8 -ErrorAction SilentlyContinue } catch {}
    Ok ("Connected! Saved connection for next time: " + $ipPort)
    Write-Host ""
}

Ok "Connected devices:"
$devices | ForEach-Object { Line $_ }

# PICK TARGET - FORCE strong-typed array, never index scalar-string's char
$targetDevice = $null
if ($devices.Count -gt 1) {
    foreach ($d in $devices) { if ($d -match ":\d+$") { $targetDevice = $d; break } }
    if (-not $targetDevice) { $targetDevice = $devices[0] }
    Warn ("Multiple devices found - will target: " + $targetDevice)
    Write-Host ""
} elseif ($devices.Count -eq 1) {
    $targetDevice = $devices[0]
}
if (-not $targetDevice) {
    Fail "No target device available."
    exit 1
}
# Safety escape for adb -s
$targetDevice = [string]$targetDevice
Line ("Target device final: " + $targetDevice)

# ---- [1/3] sync web assets ----
Write-Host "[1/3] Sync web assets (cap:sync) ..." -ForegroundColor Yellow
Push-Location $PSScriptRoot
try {
    & npm run cap:copy 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Warn "cap:copy exit=$LASTEXITCODE (will continue and try cap:sync anyway)" }
    & npm run cap:sync 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Fail ("cap:sync exit=$LASTEXITCODE. Web assets may NOT be copied into Android project - aborting APK build.")
        Pop-Location
        exit 1
    }
} finally { Pop-Location }

# ---- [1b/3] VERIFY sync: channels.js logo field present + logos/ count match ----
$androidAssetsPublic = Join-Path $PSScriptRoot "android\app\src\main\assets\public"
$srcChannelsJs = Join-Path $PSScriptRoot "www\channels.js"
$dstChannelsJs = Join-Path $androidAssetsPublic "channels.js"
$srcLogosDir    = Join-Path $PSScriptRoot "www\logos"
$dstLogosDir    = Join-Path $androidAssetsPublic "logos"
$verifyPassed = $true

Line "  [verify] Checking Android asset sync integrity..."
if (-not (Test-Path $dstChannelsJs)) {
    Fail ("  channels.js missing in Android assets: " + $dstChannelsJs)
    $verifyPassed = $false
} else {
    $checkLogo = Get-Content $dstChannelsJs -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if (-not $checkLogo -or $checkLogo -notmatch '"logo"\s*:') {
        Fail "  channels.js in Android assets has NO `"logo`" field - cap:sync copied stale file!"
        $verifyPassed = $false
    } else {
        $matches = (Select-String -InputObject $checkLogo -Pattern '"logo"\s*:' -AllMatches).Matches.Count
        Ok ("  channels.js OK: " + $matches + " logo field entries detected in Android asset copy")
    }
}
if (-not (Test-Path $dstLogosDir)) {
    Fail ("  logos/ dir missing in Android assets: " + $dstLogosDir)
    $verifyPassed = $false
} else {
    $srcCount = if (Test-Path $srcLogosDir) { (Get-ChildItem $srcLogosDir -File | Measure-Object).Count } else { 0 }
    $dstCount = (Get-ChildItem $dstLogosDir -File | Measure-Object).Count
    if ($dstCount -lt $srcCount) {
        Fail ("  logos/ sync incomplete: www/logos has $srcCount files, but Android assets only have $dstCount")
        $verifyPassed = $false
    } else {
        Ok ("  logos/ dir OK: Android asset copy has $dstCount file(s) (source www/logos has $srcCount)")
    }
}
if (-not $verifyPassed) {
    Fail "Sync integrity check FAILED. Aborting APK build to prevent installing stale old assets without logos."
    Fail "Troubleshoot: run manually -> cd mobile ; npm run cap:copy ; npm run cap:sync"
    exit 1
}
Ok "Done"
Write-Host ""

# ---- [2/3] build APK ----
Write-Host "[2/3] Build APK (assembleDebug) ..." -ForegroundColor Yellow
Push-Location ($PSScriptRoot + "\android")
try {
    $env:JAVA_HOME = $null
    $buildFailed = $false
    & .\gradlew.bat assembleDebug --no-daemon --console=plain 2>&1 | ForEach-Object {
        $L = [string]$_
        if (-not $L) { return }
        if ($L -match "^\> Task :app:(package|assemble)Debug") { Line $L }
        elseif ($L -match "^BUILD (SUCCESSFUL|FAILED)") {
            if ($L -match "SUCCESSFUL") { Ok $L }
            else { Fail $L ; $buildFailed = $true }
        }
        elseif ($L -match "^FAILURE: Build failed" -or
                ($L -match "^error:" -and $L -notmatch "Deprecated Gradle") -or
                ($L -match "\berror\b" -and $L -match "\.java:|\.kt:|\.xml:")) {
            Fail $L
            $buildFailed = $true
        }
    }
    if ($buildFailed -or ($LASTEXITCODE -ne 0)) {
        Fail ("Gradle build failed (exit=" + $LASTEXITCODE + "). Aborting to avoid installing stale old APK.")
        Pop-Location
        exit 1
    }
} finally { Pop-Location }
if (-not (Test-Path $apkPath)) {
    Fail "APK not generated. Run manually: cd mobile\android ; .\gradlew.bat assembleDebug --no-daemon"
    exit 1
}
$sizeMB = [math]::Round((Get-Item $apkPath).Length / 1MB, 2)
Ok ("Done (" + $sizeMB + " MB)")
Write-Host ""

# ---- [3/3] uninstall -> install -> launch (all with -s TARGET, use cmd/c to avoid pipe hangs) ----
Write-Host ("[3/3] Uninstall old -> Install new -> Launch (target: " + $targetDevice + ") ...") -ForegroundColor Yellow

# 1) UNINSTALL old (ignores failure)
Line "  [3a] Uninstalling old APK from $targetDevice ..."
try {
    $uRaw = cmd /c "`"$adb`" -s `"$targetDevice`" uninstall $pkg" 2`>`&1
    $uJoined = ($uRaw | Out-String).Trim()
    if ($uJoined -match "Success") { Ok "  Old APK uninstalled (cache fully cleared)" }
    elseif ($uJoined -match "Unknown package|DELETE_FAILED") { Line "  (no old APK to remove on phone)" }
    elseif ($uJoined) { Line ("  uninstall -> " + $uJoined) }
    else { Line "  (uninstall completed, no old version)" }
} catch {
    Line ("  uninstall -> error: " + $_.Exception.Message)
}

# 2) INSTALL new APK
Line "  [3b] Installing new APK to $targetDevice ..."
$installOk = $false
try {
    $iRaw = cmd /c "`"$adb`" -s `"$targetDevice`" install -r -d `"$apkPath`"" 2`>`&1
    $iJoined = ($iRaw | Out-String).Trim()
    if ($iJoined -match "Failure \[-99\]") {
        Line "  Detected OPPO/ColorOS install block [-99] -> fallback: push + pm install from /data/local/tmp ..."
        $remotePath = "/data/local/tmp/retroradio.apk"
        try {
            cmd /c "`"$adb`" -s `"$targetDevice`" shell rm `"$remotePath`"" 2`>`&1 | Out-Null
        } catch {}
        $pRaw = cmd /c "`"$adb`" -s `"$targetDevice`" push `"$apkPath`" `"$remotePath`"" 2`>`&1
        $pJoined = ($pRaw | Out-String).Trim()
        if ($pJoined) { foreach ($L in ($pJoined -split "`r?`n")) { if ($L) { Line ("    | push: " + $L) } } }
        $lRaw = cmd /c "`"$adb`" -s `"$targetDevice`" shell "pm install -r -d `"$remotePath`""" 2`>`&1
        $lJoined = ($lRaw | Out-String).Trim()
        if ($lJoined -match "Success") {
            Ok "Install OK (push fallback)"
            if ($lJoined) { foreach ($L in ($lJoined -split "`r?`n")) { if ($L) { Line ("    | pm install: " + $L) } } }
            $installOk = $true
        } else {
            Fail "Install FAILED (push fallback):"
            foreach ($L in ($lJoined -split "`r?`n")) { Line ("    | " + $L) }
        }
    } elseif ($iJoined -match "Failure|INSTALL_FAILED|not found|adb: failed") {
        Fail "Install FAILED:"
        foreach ($L in ($iJoined -split "`r?`n")) { Line ("    | " + $L) }
    } else {
        if ($iJoined) { foreach ($L in ($iJoined -split "`r?`n")) { if ($L) { Line ("  install -> " + $L) } } }
        Ok "Install OK"
        $installOk = $true
    }
} catch {
    Fail ("Install raised error: " + $_.Exception.Message)
}
if (-not $installOk) { exit 1 }
Start-Sleep -Milliseconds 600

# 3) KILL any running process + LAUNCH (clean cold start)
Line "  [3c] Launching app on $targetDevice (cold start) ..."
try {
    cmd /c "`"$adb`" -s `"$targetDevice`" shell am force-stop $pkg" 2`>`&1 | Out-Null
} catch {}
Start-Sleep -Milliseconds 400
try {
    $lRaw = cmd /c "`"$adb`" -s `"$targetDevice`" shell am start -S -W -n `"$pkg/$act`"" 2`>`&1
    $lJoined = ($lRaw | Out-String).Trim()
    if ($lJoined -match "Error type|Exception|does not exist|Activity not started|SecurityException") {
        Warn "Launch response:"
        foreach ($L in ($lJoined -split "`r?`n")) { Line ("    | " + $L) }
    } else {
        Ok "Launch OK - cold start completed."
        if ($lJoined) { foreach ($L in ($lJoined -split "`r?`n") | Select-Object -First 3) { if ($L) { Line ("  " + $L) } } }
    }
} catch {
    Warn ("Launch note: " + $_.Exception.Message)
}

Write-Host ''
Write-Host '=== Deploy Finished ===' -ForegroundColor Green
Write-Host '  versionName 1.3.33 (versionCode 33)' -ForegroundColor DarkGray
Write-Host '  DEBUG BUILD: extra RetroRadioSvc/RetroRadioBridge logs to trace playback path' -ForegroundColor DarkGray
Write-Host '  Native MediaPlayer engine (default) + LocalBinder direct path + Intent fallback + Web/hls.js fallback' -ForegroundColor DarkGray
Write-Host '  1652 stations + Bluetooth 300ms dedup + GPS-first locate' -ForegroundColor DarkGray
Write-Host '  Check your phone screen now!' -ForegroundColor Cyan
