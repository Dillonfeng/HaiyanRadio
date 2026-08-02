(function(){
  var ID = '__ID__';
  var NAME = '__NAME__';
  var URL = '__URL__';
  window.__Rpush("START_"+ID+"_"+NAME);
  console.log("[AUTO] start "+NAME+" id="+ID);
  var ch = null;
  var pools = [window.CHANNELS, window._allChannels, window.allChannels, window.radioData, window.radioChannels, window._channels, window.channelMap, window._radioMap];
  for(var i=0;i<pools.length;i++){
    var p = pools[i]; if(!p) continue;
    var vals = Array.isArray(p)? p : (typeof p==='object'? Object.values(p) : []);
    for(var j=0;j<vals.length;j++){
      var c = vals[j]; if(!c) continue;
      var cid = String(c.id||''); var cname = String(c.name||'');
      if(cid===ID || (NAME && cname.indexOf(NAME)>=0)){ ch = c; break; }
    }
    if(ch) break;
  }
  if(!ch){
    window.__Rpush("CHANNEL_NOT_FOUND_"+ID+" fallback="+URL);
    console.log("[AUTO] "+NAME+" channel-not-found, fallback URL");
    ch = { id:ID, name:NAME, url:URL, category:'test' };
  } else {
    console.log("[AUTO] "+NAME+" FOUND channel id="+ch.id+" url="+ch.url);
  }
  window.__Rpush("URL_"+ID+"_"+String(ch.url||"NULL").substring(0,100));
  // re-hook audio element (since new playChannel might recreate)
  try {
    const s2 = window.state;
    if(s2 && s2.audioElement){
      const tags2=["play","playing","pause","error","canplay","stalled","waiting","loadeddata","loadedmetadata"];
      tags2.forEach(function(tt){
        s2.audioElement.addEventListener(tt, function(e2){
          var line2 = "AUD2_"+tt.toUpperCase()+"_"+ID+" paused="+s2.audioElement.paused+" ready="+s2.audioElement.readyState+" er="+(s2.audioElement.error?s2.audioElement.error.code:0);
          console.log("[AUDIO2] "+line2); window.__Rpush(line2);
        }, true);
      });
    }
  } catch(e){}
  if(window.playChannel){
    window.__Rpush("CALL_PLAYCHANNEL_"+ID);
    try {
      setTimeout(function(){ window.playChannel(ch); }, 300);
    } catch(e){ window.__Rpush("PLAYCHANNEL_EXEC_ERR_"+ID+"_"+e.message); }
  } else {
    window.__Rpush("NOPLAYCHANNEL_"+ID);
    console.warn("[AUTO] window.playChannel not exists!");
  }
})();
