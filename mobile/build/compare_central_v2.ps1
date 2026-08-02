$ErrorActionPreference='Continue'
$ElectronCh = "D:\Trae Work\RetroRadioDesktop\channels.js"
$MobileCh   = "D:\Trae Work\RetroRadioDesktop\mobile\www\channels.js"

function Get-CentralChannels($filePath) {
    if (-not (Test-Path $filePath)) { Write-Warning "FILE MISSING $filePath"; return @() }
    $raw = Get-Content -Raw -LiteralPath $filePath -Encoding UTF8
    $m = [regex]::Match($raw, 'const\s+CHANNEL_DATA\s*=\s*(\{[\s\S]*\})\s*;?\s*$')
    if (-not $m.Success) { Write-Warning "Cannot parse CHANNEL_DATA in $filePath"; return @() }
    try {
        $obj = $m.Groups[1].Value | ConvertFrom-Json -ErrorAction Stop
        $radio = $obj.radio
        if (-not $radio) { Write-Warning "No radio array"; return @() }
        $central = $radio | Where-Object { ($_.description -eq '中央') -or ($_.name -match '故城') }
        return @($central)
    } catch {
        Write-Warning ("JSON parse failed for " + $filePath + ": " + $_.Exception.Message)
        return @()
    }
}

Write-Host "=== ELECTRON channels.js (root folder) ===" -ForegroundColor Magenta
$e = Get-CentralChannels $ElectronCh
Write-Host ("   TOTAL central/gucheng = " + $e.Count)
for ($i=0; $i -lt $e.Count; $i++) {
    $c = $e[$i]
    $u = $c.url
    if ($u -match '\?') { $u = $u.Substring(0, $u.IndexOf('?')) }
    Write-Host ("   [" + $i + "] id=" + $c.id + " NAME=" + $c.name + " DESC=" + $c.description)
}

Write-Host ""
Write-Host "=== MOBILE channels.js (mobile/www folder) ===" -ForegroundColor Cyan
$m = Get-CentralChannels $MobileCh
Write-Host ("   TOTAL central/gucheng = " + $m.Count)
for ($i=0; $i -lt $m.Count; $i++) {
    $c = $m[$i]
    $u = $c.url
    if ($u -match '\?') { $u = $u.Substring(0, $u.IndexOf('?')) }
    Write-Host ("   [" + $i + "] id=" + $c.id + " NAME=" + $c.name + " DESC=" + $c.description)
}

Write-Host ""
Write-Host "=== filesize/lastWriteTime ==="
Get-Item -LiteralPath $ElectronCh,$MobileCh -ErrorAction SilentlyContinue | Select-Object FullName,Length,LastWriteTime | Format-Table -AutoSize | Out-Host
try {
    $he = (Get-FileHash -LiteralPath $ElectronCh -Algorithm MD5 -ErrorAction Stop).Hash
    $hm = (Get-FileHash -LiteralPath $MobileCh   -Algorithm MD5 -ErrorAction Stop).Hash
    Write-Host ("   Electron MD5 = " + $he)
    Write-Host ("   Mobile   MD5 = " + $hm)
    if ($he -eq $hm) { Write-Host "   PASS byte-identical" -ForegroundColor Green }
    else { Write-Host "   FAIL files DIFFERENT !!!" -ForegroundColor Red }
} catch { Write-Warning ("hash failed: " + $_.Exception.Message) }
