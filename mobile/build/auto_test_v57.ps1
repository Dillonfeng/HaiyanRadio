$ErrorActionPreference='Continue'
$ADB = "D:\Trae Work\RetroRadioDesktop\mobile\android-sdk\platform-tools\adb.exe"
$ADB_HOST = "192.168.0.103:44293"
$PKG = "com.retro.radio"

function A($a){ & $ADB -s $ADB_HOST @a 2>&1 }

function InjectBase64Js($jsCode){
  $utf8 = [System.Text.Encoding]::UTF8.GetBytes($jsCode)
  $b64 = [System.Convert]::ToBase64String($utf8)
  $wrap = "try{ (new Function(atob('$b64')))(); }catch(e){ console.error('[WRAPPER] '+e.message); }"
  A @("shell","am","broadcast","-a","com.retro.radio.DEBUG_EVAL_JS","--es","js",$wrap) 2>&1 | Select-Object -First 2
}

Write-Host "=== [0] 重启APP 清logcat 初始化hook ===" -ForegroundColor Cyan
A @("shell","am","force-stop",$PKG) | Out-Null
Start-Sleep -Milliseconds 800
A @("shell","am","start","-n","com.retro.radio/.MainActivity","-a","android.intent.action.MAIN","-c","android.intent.category.LAUNCHER") | Out-Null
Write-Host "  等首屏渲染 7 秒"
Start-Sleep -Seconds 7
A @("logcat","-G","16M") | Out-Null
A @("logcat","-c") | Out-Null
Start-Sleep -Milliseconds 400

$initJs = @'
(function(){
  window.__R = [];
  window.__Rpush = function(m){ try { window.__R.push({t:Date.now(), m:m}); } catch(e){} };
  window.__Rpush("INIT_HOOK");
  console.log("[AUTO] INIT_HOOK_OK");
  function hookAudioOnce(){
    try{
      const s = window.state;
      if(!s) return setTimeout(hookAudioOnce, 200);
      let a = s.audioElement;
      if(!a){ s.audioElement = a = document.createElement("audio"); }
      const tags=["play","playing","pause","error","canplay","canplaythrough","stalled","waiting","loadeddata","loadedmetadata","suspend","abort","emptied","ended"];
      tags.forEach(t=>a.addEventListener(t,function(ev){
        const line = "AUDIO_"+t.toUpperCase()+" paused="+a.paused+" ready="+a.readyState+" er="+(a.error?a.error.code:0)+" src="+(a.src||"").substring(0,50);
        console.log("[AUDIO] "+line); window.__Rpush(line);
      }, true));
      console.log("[AUTO] AUDIO_HOOKED src="+a.src);
      window.__Rpush("AUDIO_HOOKED");
    }catch(e){ setTimeout(hookAudioOnce,200); }
  }
  hookAudioOnce();
  const origHls = window.Hls;
  if(origHls){
    try{
      const origLoad = origHls.prototype.loadSource;
      origHls.prototype.loadSource = function(u){ console.log("[HLS] loadSource "+u); window.__Rpush("HLS_LOADSOURCE "+u.substring(0,60)); return origLoad.apply(this,arguments); };
      const origAttach = origHls.prototype.attachMedia;
      origHls.prototype.attachMedia = function(el){ console.log("[HLS] attachMedia"); window.__Rpush("HLS_ATTACH"); return origAttach.apply(this,arguments); };
      const origOn = origHls.prototype.on;
      origHls.prototype.on = function(){
        const evName = arguments[0];
        if(String(evName).toUpperCase().indexOf("ERROR")>=0){
          const origCb = arguments[1];
          arguments[1] = function(evt,data){
            const m = "HLS_ERROR type="+(data&&data.type)+" details="+(data&&data.details)+" fatal="+(data&&data.fatal);
            console.log("[HLS] "+m); window.__Rpush(m);
            return origCb.apply(this,arguments);
          };
        }
        return origOn.apply(this,arguments);
      };
    }catch(e){}
  }
})();
'@

InjectBase64Js $initJs | Out-Null
Start-Sleep -Seconds 3

$tests = @(
  @{id='r47';  name='环球资讯广播'},
  @{id='r130'; name='经济之声'},
  @{id='bk67'; name='光华之声'},
  @{id='bk105';name='大千电台FM99.1'}
)

$report = @(); $i=0;
foreach($t in $tests){
  $i++; $id = $t.id; $name = $t.name;
  Write-Host "`n===== [$i/4] $name (id=$id) =====" -ForegroundColor DarkCyan;
  A @("logcat","-c") | Out-Null; Start-Sleep -Milliseconds 300;

  $playJs = @"
(function(){
  const ID = "$id"; const NAME = "$name";
  window.__Rpush("START_"+ID+"_"+NAME);
  console.log("[AUTO] start "+NAME);
  let ch = null;
  const pools = [window.CHANNELS, window._allChannels, window.allChannels, window.radioData, window.radioChannels, window._channels, window.channelMap];
  for(const p of pools){
    if(!p) continue;
    const vals = (Array.isArray(p)? p : Object.values(p));
    for(const c of vals){
      if(c && (c.id===ID || (c.name && String(c.name).indexOf(NAME)>=0))){ ch=c; break; }
    }
    if(ch) break;
  }
  if(!ch){
    console.log("[AUTO] "+NAME+" channel-not-found, fallback synthetic");
    window.__Rpush("CHANNEL_NOT_FOUND_"+ID);
    const fallbackUrls = {
      'r47':'http://sk.cri.cn/905.m3u8',
      'r130':'https://ngcdn002.cnr.cn/live/jjzs/index.m3u8',
      'bk67':'http://202.39.43.67:1935/live/RA000077/chunklist.m3u8',
      'bk105':'http://125.227.87.206:8000/FM99.1'
    };
    ch = { id:ID, name:NAME, url: fallbackUrls[ID]||'', category:'test' };
  }
  console.log("[AUTO] "+NAME+" final URL="+ch.url);
  window.__Rpush("URL_"+ID+"_"+(ch.url||"NULL").substring(0,80));
  if(window.playChannel){
    setTimeout(function(){
      try{
        window.__Rpush("CALL_PLAYCHANNEL_"+ID);
        window.playChannel(ch);
      }catch(e){ console.error("[AUTO] playChannel err: "+e.message); window.__Rpush("PLAYCHANNEL_ERR_"+ID+"_"+e.message); }
    }, 350);
  } else {
    window.__Rpush("NOPLAYCHANNEL_"+ID);
  }
})();
"@
  InjectBase64Js $playJs | Out-Null;
  Write-Host "  注入 playChannel($id)，等待13秒观察..."
  Start-Sleep -Seconds 13

  $dumpJs = @"
(function(){
  const ID = "$id"; const NAME = "$name";
  const rep = (window.__R||[]).filter(function(x){
    const s = (x.m||x).toString();
    return s.indexOf(ID)>=0 || /^AUDIO_|^HLS_|PLAYCHANNEL|CALL_PLAY|CHANNEL_NOT_FOUND/.test(s);
  }).slice(-60);
  const s = window.state || {};
  const a = s.audioElement || {};
  const st = {
    isPlaying: !!s.isPlaying, currentId: s.currentId || '',
    paused: a.paused, readyState: a.readyState, errorCode: (a.error?a.error.code:0),
    src: (a.src||'').substring(0,120), currentTime: a.currentTime||0, duration: a.duration||0,
    networkState: a.networkState
  };
  const obj = { id:ID, name:NAME, report:rep, state:st };
  try {
    const json = JSON.stringify(obj);
    console.log("[REPORT:"+ID+"] "+json);
  } catch(e){
    console.log("[REPORT:"+ID+"] STRINGIFY_FAIL "+e.message);
    console.log("[REPORT:"+ID+"] state="+JSON.stringify(st));
  }
  window.__Rpush("DUMPED_"+ID);
})();
"@
  InjectBase64Js $dumpJs | Out-Null;
  Start-Sleep -Seconds 3

  $log = A @("logcat","-d","-v","time","-s","Console","RetroRadioMain","chromium","Capacitor/Console","RadioPlaybackService","System.err","MediaPlayer","AudioManager") 2>&1
  $rel = $log | Select-String -Pattern '\[AUDIO|\[AUTO|\[REPORT:|\[HLS\]|RetroRadioMain|AUDIO_|HLS_|PLAYCHANNEL|CHANNEL_NOT_FOUND|DUMPED_|WebEngine|AudioFocus|MediaPlayer' | ForEach-Object { $_.ToString() }
  $rel | Select-Object -Last 70 | ForEach-Object { Write-Host "    $_" }

  $success=$false; $note='NO DATA';
  if($rel -match "\[REPORT:$id\]"){
    $line = ($rel | Select-String -Pattern "\[REPORT:$id\]" | Select-Object -Last 1).Line;
    if($line -match '\[REPORT:[^\]]+\]\s*(\{.*\})\s*$'){
      try {
        $j = $matches[1] | ConvertFrom-Json;
        $evts = @($j.report | ForEach-Object { $_.m ? $_.m : $_ });
        $hasPlaying = @($evts | Select-String -Pattern 'AUDIO_PLAYING').Count -gt 0;
        $hasPauseAfter = $false;
        $playingIdx = -1; $pauseIdx = -1;
        for($k=0;$k -lt $evts.Count;$k++){
          if($evts[$k] -match 'AUDIO_PLAYING'){ $playingIdx = $k }
          if($evts[$k] -match 'AUDIO_PAUSE(?!D)'){ $pauseIdx = $k }
        }
        if($playingIdx -ge 0 -and $pauseIdx -gt $playingIdx){ $hasPauseAfter = $true }
        $hasErr = @($evts | Select-String -Pattern 'AUDIO_ERROR|HLS_ERROR fatal=true|ERR_|无法播放|播放失败|MEDIA_ERR').Count -gt 0;
        $stateBad = ($j.state.paused -eq $true) -or ($j.state.errorCode -ne 0 -and $null -ne $j.state.errorCode);
        $success = $hasPlaying -and (-not $hasPauseAfter) -and (-not $hasErr) -and (-not $stateBad);
        $note = "hasPlaying=$hasPlaying pauseAfter=$hasPauseAfter hasErr=$hasErr state.isPlaying=$($j.state.isPlaying) paused=$($j.state.paused) erCode=$($j.state.errorCode) ready=$($j.state.readyState) net=$($j.state.networkState) src=$($j.state.src)";
      } catch { $note = "JSON PARSE FAIL: $_" }
    }
  }
  if($success){ Write-Host "  ✅ PASS $name" -ForegroundColor Green } else { Write-Host "  ❌ FAIL $name — $note" -ForegroundColor Red }
  $report += [PSCustomObject]@{i=$i;name=$name;id=$id;ok=$success;note=$note};

  $stopJs = @"
(function(){
  try {
    if(window.stopPlaying){ window.stopPlaying(); }
    else {
      try {
        var s=window.state;
        if(s && s.audioElement){s.audioElement.pause();s.audioElement.removeAttribute('src');s.isPlaying=false;}
      }catch(e){}
    }
    window.__Rpush("STOPPED_$id");
  } catch(e){}
})();
"@
  InjectBase64Js $stopJs | Out-Null;
  Start-Sleep -Seconds 2
}

Write-Host "`n`n========== 自动测试最终报告 ==========" -ForegroundColor Yellow
$report | Format-Table -AutoSize -Wrap | Out-String | Write-Host
Write-Host "========== End of Test ==========" -ForegroundColor Yellow
