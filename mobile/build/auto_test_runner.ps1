$ErrorActionPreference = 'Continue'
$ADB = 'D:\Trae Work\RetroRadioDesktop\mobile\android-sdk\platform-tools\adb.exe'
$ADB_HOST = '192.168.0.103:44293'
$PKG = 'com.retro.radio'
$BUILD = 'D:\Trae Work\RetroRadioDesktop\mobile\build'

function A($argsArr){ & $ADB -s $ADB_HOST @argsArr 2>&1 }

function InjectB64File($jsFilePath){
  $raw = [System.IO.File]::ReadAllBytes($jsFilePath)
  $b64 = [System.Convert]::ToBase64String($raw)
  $wrap = 'try{(new Function(atob("' + $b64 + '")))();}catch(exx){console.error("[WRAP]",exx.message||exx);}'
  $result = A @('shell','am','broadcast','-a','com.retro.radio.DEBUG_EVAL_JS','--es','js',$wrap) 2>&1
  return ($result | Select-Object -First 1)
}

Write-Host '=== [0] restart app, clear logcat ===' -ForegroundColor Cyan
A @('shell','am','force-stop',$PKG) | Out-Null
Start-Sleep -Milliseconds 800
A @('shell','am','start','-n','com.retro.radio/.MainActivity','-a','android.intent.action.MAIN','-c','android.intent.category.LAUNCHER') | Out-Null
Write-Host '  waiting first screen 7 seconds'
Start-Sleep -Seconds 7
A @('logcat','-G','16M') | Out-Null
A @('logcat','-c') | Out-Null
Start-Sleep -Milliseconds 400

Write-Host '=== [1] inject wrapper definition ===' -ForegroundColor Cyan
InjectB64File (Join-Path $BUILD 'auto_test_wrapper.js') | Out-Null
Start-Sleep -Milliseconds 600

Write-Host '=== [2] inject init hook (audio+HLS events) ===' -ForegroundColor Cyan
InjectB64File (Join-Path $BUILD 'auto_test_init.js') | Out-Null
Start-Sleep -Seconds 3

$tests = @(
  @{id='r47';  name='huan_qiu';     url='http://sk.cri.cn/905.m3u8'},
  @{id='r130'; name='jing_ji';      url='https://ngcdn002.cnr.cn/live/jjzs/index.m3u8'},
  @{id='bk67'; name='guang_hua';    url='http://202.39.43.67:1935/live/RA000077/chunklist.m3u8'},
  @{id='bk105';name='da_qian';      url='http://125.227.87.206:8000/FM99.1'}
)

$playTmpl = [System.IO.File]::ReadAllText((Join-Path $BUILD 'auto_test_play_tmpl.js'))
$dumpTmpl = [System.IO.File]::ReadAllText((Join-Path $BUILD 'auto_test_dump_tmpl.js'))
$stopJsPath = Join-Path $BUILD 'auto_test_stop.js'
$report = @()
$idx = 0

foreach($t in $tests){
  $idx++
  $id = $t.id
  $rawName = $t.name
  $url = $t.url
  $displayName = switch ($id){
    'r47'   { '环球资讯广播' }
    'r130'  { '经济之声' }
    'bk67'  { '光华之声' }
    'bk105' { '大千电台FM99.1' }
    default { $id }
  }
  Write-Host "`n===== [$idx/4] $displayName ($id) =====" -ForegroundColor DarkCyan
  A @('logcat','-c') | Out-Null
  Start-Sleep -Milliseconds 300

  $playJs = $playTmpl.Replace('__ID__', $id).Replace('__NAME__', $displayName).Replace('__URL__', $url)
  $playFile = Join-Path $BUILD "tmp_play_$id.js"
  [System.IO.File]::WriteAllText($playFile, $playJs, [System.Text.Encoding]::UTF8)
  InjectB64File $playFile | Out-Null

  Write-Host '  playChannel injected, wait 13 seconds for playback events'
  Start-Sleep -Seconds 13

  $dumpJs = $dumpTmpl.Replace('__ID__', $id).Replace('__NAME__', $displayName)
  $dumpFile = Join-Path $BUILD "tmp_dump_$id.js"
  [System.IO.File]::WriteAllText($dumpFile, $dumpJs, [System.Text.Encoding]::UTF8)
  InjectB64File $dumpFile | Out-Null
  Start-Sleep -Seconds 3

  $log = A @('logcat','-d','-v','time','-s','Console','RetroRadioMain','chromium','Capacitor/Console','RadioPlaybackService','System.err','MediaPlayer','AudioManager') 2>&1
  $rel = $log | Select-String -Pattern '\[AUDIO|\[AUTO|\[REPORT:|\[HLS\]|RetroRadioMain|AUDIO_|HLS_|PLAYCHANNEL|CHANNEL_NOT_FOUND|DUMPED_|AudioFocus|MediaPlayer|wrapper' | ForEach-Object { $_.ToString() }
  $rel | Select-Object -Last 70 | ForEach-Object { Write-Host "    $_" }

  $success = $false
  $note = 'NO_DATA'
  if($rel -match "\[REPORT:$id\]"){
    $line = ($rel | Select-String -Pattern "\[REPORT:$id\]" | Select-Object -Last 1).Line
    if($line -match '\[REPORT:[^\]]+\]\s*(\{.*\})\s*$'){
      try{
        $j = $matches[1] | ConvertFrom-Json
        $evts = @($j.report | ForEach-Object { if($_.m){$_.m}else{$_} })
        $hasPlaying = @($evts | Select-String -Pattern 'AUDIO_PLAYING|AUD2_PLAYING').Count -gt 0
        $playingIdx = -1
        $pauseIdx = -1
        for($k=0;$k -lt $evts.Count; $k++){
          if($evts[$k] -match 'AUDIO_PLAYING|AUD2_PLAYING'){ $playingIdx = $k }
          if($evts[$k] -match 'AUDIO_PAUSE|AUD2_PAUSE'){ $pauseIdx = $k }
        }
        $pauseAfter = ($playingIdx -ge 0 -and $pauseIdx -gt $playingIdx)
        $hasErr = @($evts | Select-String -Pattern 'AUDIO_ERROR|AUD2_ERROR|HLS_ERROR fatal=True|HLS_ERROR fatal=true|PLAYCHANNEL_EXEC_ERR|ERR_|播放失败|无法播放|MEDIA_ERR').Count -gt 0
        $stateBad = ($j.state.paused -eq $true -or ($j.state.errorCode -ne 0 -and $null -ne $j.state.errorCode))
        $success = $hasPlaying -and (-not $pauseAfter) -and (-not $hasErr) -and (-not $stateBad)
        $note = "hasPlaying=$hasPlaying pauseAfter=$pauseAfter hasErr=$hasErr st.isPlaying=$($j.state.isPlaying) paused=$($j.state.paused) er=$($j.state.errorCode) ready=$($j.state.readyState) src=$($j.state.src)"
      } catch {
        $note = "JSON_PARSE_FAIL $_"
      }
    }
  }
  if($success){
    Write-Host "  PASS OK $displayName" -ForegroundColor Green
  } else {
    Write-Host "  FAIL $displayName - $note" -ForegroundColor Red
  }
  $report += [PSCustomObject]@{i=$idx;name=$displayName;id=$id;ok=$success;note=$note}
  InjectB64File $stopJsPath | Out-Null
  Start-Sleep -Seconds 2
}

Write-Host "`n`n========== AUTO TEST v57 FINAL REPORT ==========" -ForegroundColor Yellow
$report | Format-Table -AutoSize -Wrap | Out-String | Write-Host
Write-Host '========== END ==========' -ForegroundColor Yellow
