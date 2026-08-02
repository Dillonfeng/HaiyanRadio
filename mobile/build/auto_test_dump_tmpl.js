(function(){
  var ID = '__ID__';
  var NAME = '__NAME__';
  var arr = (window.__R||[]).slice();
  function mat(v){ v = String(v); return v.indexOf(ID)>=0 || /^AUDIO_|^AUD2_|^HLS_|PLAYCHANNEL|CALL_PLAY|CHANNEL_NOT_FOUND/.test(v); }
  var rep = arr.filter(function(x){ var s = (x && x.m)? x.m : String(x); return mat(s); }).slice(-80);
  var s = window.state || {};
  var a = s.audioElement || {};
  var st = {
    isPlaying: !!s.isPlaying, currentId: s.currentId || '',
    paused: !!a.paused, readyState: a.readyState||0, errorCode: (a.error? a.error.code: 0),
    src: String(a.src||'').substring(0,140),
    currentTime: a.currentTime||0,
    networkState: a.networkState||0,
    hlsOn: !!window.state && !!window.state.hls
  };
  var obj = { id:ID, name:NAME, report:rep, state:st };
  try {
    var json = JSON.stringify(obj);
    console.log("[REPORT:"+ID+"] "+json);
  } catch(e){
    console.log("[REPORT:"+ID+"] STRINGIFY_FAIL "+e.message);
  }
  window.__Rpush("DUMPED_"+ID);
})();
