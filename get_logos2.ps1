$channelData = Get-Content "d:\Trae Work\RetroRadioDesktop\mobile\www\channels.js" -Raw

$urlPattern = 'https://lhttp\.qtfm\.cn/live/(\d+)/'
$matches = [regex]::Matches($channelData, $urlPattern)

$uniqueIds = @()
foreach ($match in $matches) {
    $id = $match.Groups[1].Value
    if (-not $uniqueIds.Contains($id)) {
        $uniqueIds += $id
    }
}

Write-Host "Found $($uniqueIds.Count) unique qtfm radio IDs"

$allRadios = @{}
$processedCount = 0
$successCount = 0

foreach ($id in $uniqueIds) {
    try {
        $url = "https://www.qtfm.cn/radios/$id/"
        Write-Host "[$($processedCount + 1)/$($uniqueIds.Count)] Fetching: $url"
        
        $html = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10
        $content = $html.Content
        
        $startIdx = $content.IndexOf("window.__initStores")
        if ($startIdx -lt 0) {
            Write-Host "  No init data"
            $processedCount++
            continue
        }
        
        $endIdx = $content.IndexOf("</script>", $startIdx)
        if ($endIdx -lt 0) {
            $endIdx = $startIdx + 50000
        }
        
        $storeStr = $content.Substring($startIdx, $endIdx - $startIdx)
        $storeStr = $storeStr.Trim()
        $storeStr = $storeStr.Substring("window.__initStores = ".Length)
        $storeStr = $storeStr.TrimEnd(';')
        
        $storeObj = $storeStr | ConvertFrom-Json
        
        if ($storeObj.RadioDetailStore -and $storeObj.RadioDetailStore.radio) {
            $radio = $storeObj.RadioDetailStore.radio
            if ($radio.imgUrl) {
                $logoUrl = $radio.imgUrl
                if ($logoUrl.StartsWith("//")) {
                    $logoUrl = "https:" + $logoUrl
                }
                
                $allRadios[$id] = @{
                    id = $id
                    name = $radio.name -replace '\s+', ' '
                    logo = $logoUrl
                    source = "detail"
                }
                $successCount++
                Write-Host "  OK: $($radio.name)"
            }
        }
    }
    catch {
        Write-Host "  Error: $_"
    }
    
    $processedCount++
    if ($processedCount % 20 -eq 0) {
        Start-Sleep -Seconds 2
    } else {
        Start-Sleep -Seconds 0.3
    }
}

Write-Host "`nTotal success: $successCount"

$output = @()
foreach ($key in $allRadios.Keys) {
    $output += $allRadios[$key]
}

$output | ConvertTo-Json | Out-File -FilePath "d:\Trae Work\RetroRadioDesktop\radio_logos_detail.json" -Encoding utf8

Write-Host "Saved to radio_logos_detail.json"