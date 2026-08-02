$categories = @(
    @{id=1; name="Hot"},
    @{id=2; name="Shanghai"},
    @{id=3; name="Guangdong"},
    @{id=4; name="Tianjin"},
    @{id=6; name="Chongqing"},
    @{id=7; name="Liaoning"},
    @{id=8; name="Jilin"},
    @{id=9; name="Heilongjiang"},
    @{id=10; name="Hebei"},
    @{id=11; name="Shanxi"},
    @{id=12; name="Shandong"},
    @{id=13; name="Jiangsu"},
    @{id=14; name="Zhejiang"},
    @{id=15; name="Anhui"},
    @{id=16; name="Fujian"},
    @{id=17; name="Jiangxi"},
    @{id=18; name="Henan"},
    @{id=19; name="Hubei"},
    @{id=20; name="Hunan"},
    @{id=21; name="Guangxi"},
    @{id=22; name="Hainan"},
    @{id=23; name="Sichuan"},
    @{id=24; name="Guizhou"},
    @{id=25; name="Yunnan"},
    @{id=26; name="Xizang"},
    @{id=27; name="Shaanxi"},
    @{id=28; name="Gansu"},
    @{id=29; name="Qinghai"},
    @{id=30; name="Ningxia"},
    @{id=31; name="Xinjiang"},
    @{id=32; name="Neimenggu"},
    @{id=407; name="Internet"}
)

$allRadios = @{}
$baseUrl = "https://www.qtfm.cn/radiopage/"
$maxPages = 5

foreach ($cat in $categories) {
    for ($page = 1; $page -le $maxPages; $page++) {
        try {
            $url = "$($baseUrl)$($cat.id)/$page"
            Write-Host "Fetching: $($cat.name) page $page - $url"
            $html = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 15
            $content = $html.Content
            
            $startIdx = $content.IndexOf("radioPlaying")
            if ($startIdx -lt 0) {
                Write-Host "  No radioPlaying found"
                break
            }
            
            $arrayStart = $content.IndexOf("[", $startIdx)
            if ($arrayStart -lt 0) {
                Write-Host "  No array start found"
                break
            }
            
            $depth = 0
            $arrayEnd = -1
            for ($i = $arrayStart; $i -lt $content.Length; $i++) {
                if ($content[$i] -eq '[') { $depth++ }
                elseif ($content[$i] -eq ']') { $depth-- }
                
                if ($depth -eq 0) {
                    $arrayEnd = $i
                    break
                }
            }
            
            if ($arrayEnd -lt 0) {
                Write-Host "  No array end found"
                break
            }
            
            $arrayStr = $content.Substring($arrayStart, $arrayEnd - $arrayStart + 1)
            $radioArray = $arrayStr | ConvertFrom-Json
            
            if ($radioArray.Count -eq 0) {
                Write-Host "  No more radios"
                break
            }
            
            foreach ($radio in $radioArray) {
                if ($radio.imgUrl -and $radio.name -and $radio.to) {
                    $logoUrl = $radio.imgUrl
                    $name = $radio.name.Trim()
                    
                    $match = [regex]::Match($radio.to, '/radios/(\d+)')
                    if ($match.Success) {
                        $id = $match.Groups[1].Value
                        
                        if ($logoUrl.StartsWith("//")) {
                            $logoUrl = "https:" + $logoUrl
                        }
                        
                        if (-not $allRadios.ContainsKey($id)) {
                            $allRadios[$id] = @{
                                id = $id
                                name = $name
                                logo = $logoUrl
                                catName = $cat.name
                            }
                        }
                    }
                }
            }
            
            Write-Host "  Got $($radioArray.Count) radios"
        }
        catch {
            Write-Host "  Error: $_"
            break
        }
        Start-Sleep -Seconds 0.5
    }
}

Write-Host "`nTotal radios: $($allRadios.Count)"

$output = @()
foreach ($key in $allRadios.Keys) {
    $output += $allRadios[$key]
}

$output | ConvertTo-Json | Out-File -FilePath "d:\Trae Work\RetroRadioDesktop\radio_logos_full.json" -Encoding utf8

Write-Host "Saved to radio_logos_full.json"