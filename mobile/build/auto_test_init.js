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
      tags.forEach(function(t){
        a.addEventListener(t,function(ev){
          const line = "AUDIO_"+t.toUpperCase()+" paused="+a.paused+" ready="+a.readyState+" er="+(a.error?a.error.code:0)+" src="+(a.src||"").substring(0,60);
          console.log("[AUDIO] "+line);
          window.__Rpush(line);
        }, true);
      });
      console.log("[AUTO] AUDIO_HOOKED");
      window.__Rpush("AUDIO_HOOKED");
    }catch(e){ setTimeout(hookAudioOnce,200); }
  }
  hookAudioOnce();
  // hls hook
  try {
    const H = window.Hls;
    if(H){
      const oL = H.prototype.loadSource;
      H.prototype.loadSource = function(u){ console.log("[HLS] loadSource "+u); window.__Rpush("HLS_LOADSOURCE "+(u||"").substring(0,80)); return oL.apply(this,arguments); };
      const oA = H.prototype.attachMedia;
      H.prototype.attachMedia = function(el){ console.log("[HLS] attachMedia"); window.__Rpush("HLS_ATTACH"); return oA.apply(this,arguments); };
      const oO = H.prototype.on;
      H.prototype.on = function(evName, cb){
        if(String(evName).toUpperCase().indexOf("ERROR")>=0 && typeof cb==="function"){
          var origCb = cb;
          cb = function(evt,data){
            var m = "HLS_ERROR type="+(data&&data.type)+" details="+(data&&data.details)+" fatal="+(data&&data.fatal);
            console.log("[HLS] "+m); window.__Rpush(m);
            return origCb.apply(this,arguments);
          };
        }
        return oO.call(this,evName,cb);
      };
    }
  } catch(e){}
})();
