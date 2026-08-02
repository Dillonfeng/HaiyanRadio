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
        Write-Warning "JSON parse failed for $filePath`: $_"
        return @()
    }
}

Write-Host "=== ELECTRON channels.js (root folder) ===" -ForegroundColor Magenta
$e = Get-CentralChannels $ElectronCh
Write-Host "   总数 = $($e.Count) 条中央/故城台"
for ($i=0; $i -lt $e.Count; $i++) {
    $c = $e[$i]
    Write-Host ("   [{0,2}] id={1,-8} name={2} desc={3} url={4}" -f $i, ($c.id), ($c.name), ($c.description), ($c.url -replace '\?.+$',''))
}

Write-Host "`n=== MOBILE channels.js (mobile/www folder) ===" -ForegroundColor Cyan
$m = Get-CentralChannels $MobileCh
Write-Host "   总数 = $($m.Count) 条中央/故城台"
for ($i=0; $i -lt $m.Count; $i++) {
    $c = $m[$i]
    Write-Host ("   [{0,2}] id={1,-8} name={2} desc={3} url={4}" -f $i, ($c.id), ($c.name), ($c.description), ($c.url -replace '\?.+$',''))
}

Write-Host "`n=== DIFF: compare by (id+name+url) ===" -ForegroundColor Yellow
$eKeys = @()
foreach ($c in $e) { $eKeys += ($c.id+'|'+$c.name+'|'+($c.url -replace '\?.+$','')) }
$mKeys = @()
foreach ($c in $m) { $mKeys += ($c.id+'|'+$c.name+'|'+($c.url -replace '\?.+$','')) }
$diff = Compare-Object -ReferenceObject $eKeys -DifferenceObject $mKeys
if (-not $diff) {
    Write-Host "   ✅ 两个文件的中央分组完全一致！" -ForegroundColor Green
} else {
    Write-Host "   ❌ 文件不一致！差异：" -ForegroundColor Red
    $diff | Format-List | Out-Host
}

Write-Host "`n=== RAW filesize/hash check ===" -ForegroundColor Yellow
Get-Item -LiteralPath $ElectronCh,$MobileCh -ErrorAction SilentlyContinue | Select-Object FullName,Length,LastWriteTime | Format-Table -AutoSize | Out-Host
$he = (Get-FileHash -LiteralPath $ElectronCh -Algorithm MD5 -ErrorAction SilentlyContinue).Hash
$hm = (Get-FileHash -LiteralPath $MobileCh   -Algorithm MD5 -ErrorAction SilentlyContinue).Hash
Write-Host "   Electron MD5 = $he"
Write-Host "   Mobile   MD5 = $hm"
if ($he -eq $hm -and $he) { Write-Host "   ✅ MD5相同 = 字节级完全一致" -ForegroundColor Green }
else { Write-Host "   ❌ MD5不同 = 两个文件内容不同！" -ForegroundColor Red }
