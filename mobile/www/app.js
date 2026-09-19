const state = {
  channels: { radio: [], tv: [] },
  currentChannel: null,
  isPlaying: false,
  favorites: [],
  history: [],
  customChannels: [],
  userStations: [],
  currentFilter: '全部',
  manageFilter: '全部',
  searchQuery: '',
  timer: null,
  timerEnd: 0,
  audioContext: null,
  audioElement: null,
  hls: null,
  currentTimer: 0,
  lastNativeReported: null,
  hasReportedAnyPlayback: false,
  pinnedProvince: '',
  playbackEngine: 'web'
};

const DATA_VERSION = '20260902-V157-USER-EDIT-MERGE-SAFE';  // V158 未涉及频道数据结构，DATA_VERSION 保持 V157 以避免触发 forceReset
const APP_VERSION = 'v1.3.217 (V217 横屏VU:扬声器补偿320→400ms(320仍超前;日志实证route=spk延迟线生效,ColorOS深缓冲400ms级);若400仍超前则转入回落速度假设(慢回落尾音残留被读作超前);弹道α0.8/fn5.0/ζ0.9;V210真相=处理器在AudioTrack深缓冲前需延迟线;V207分段刷新512帧+rAF;Java峰值供能+非对称包络+动圈表头仿真;V193浅色主题;V191原生RMS)';
const VERSION_DISPLAY = 'V217';


const DATA_VERSION_KEY = 'radio_data_version';
const THEME_KEY = 'radio_theme_pref';
const FONT_KEY = 'radio_font_pref';
const LOCATION_KEY = 'radio_last_location';
const LAST_PLAY_KEY = 'radio_last_play';

const isNativeApp = (typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform) || (typeof window.NativeRadio !== 'undefined');

const els = {};
let editingId = null;

function $(id) { return document.getElementById(id); }

function hasNative() { return typeof window.NativeRadio !== 'undefined' && window.NativeRadio; }
// V118: 检查原生 ExoPlayer 引擎是否可用 — 通过 shouldInterceptRequest RPC 通道 (addJavascriptInterface在ColorOS失效)
function hasNativeAudio() {
  return !!window.__NATIVE_AUDIO_READY;
}
// V118: 通过 shouldInterceptRequest RPC 通道调用原生 ExoPlayer
// 使用同步 XMLHttpRequest (async:false) — 因为走 shouldInterceptRequest 本地拦截，
// 延迟 <1ms，不会卡顿。同步调用确保 togglePlay 中状态立即正确更新，避免闪烁和竞争。
function nativeAudioRpc(action, params) {
  try {
    var q = '/__nativeaudio__/' + action;
    if (params) {
      var parts = [];
      for (var k in params) {
        if (params.hasOwnProperty(k)) {
          parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k] || ''));
        }
      }
      if (parts.length) q += '?' + parts.join('&');
    }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', q, false);  // 同步！
    xhr.send(null);
    if (xhr.status >= 200 && xhr.status < 300) {
      var resp = JSON.parse(xhr.responseText || '{}');
      if (resp && resp.ok) {
        return resp;  // V121: 返回完整响应对象（含 isPlaying）
      } else {
        console.warn('[V121-RPC] server returned error:', resp && resp.err);
        return null;
      }
    } else {
      console.warn('[V121-RPC] HTTP', xhr.status, 'for', action);
      return null;
    }
  } catch(e) {
    console.warn('[V121-RPC] error:', action, e);
    return null;
  }
}

function reportNativeState(force) {
  if (!hasNative()) return;
  if (state.playbackEngine === 'native') {
    const ch = state.currentChannel;
    if (!ch) {
      if (!state.hasReportedAnyPlayback) return;
      if (force || state.lastNativeReported !== 'stopped') {
        state.lastNativeReported = 'stopped';
        try { window.NativeRadio.reportStopped && window.NativeRadio.reportStopped(); } catch (e) {}
      }
      return;
    }
    // V159 FIX: native引擎也要通知Service播放/暂停状态，否则Service不知道用户暂停了→降级Timer永远不触发
    const nName = ch.name || '';
    const nSub = (ch.frequency || '') + (ch.description ? ' · ' + ch.description : '');
    const nPlaying = !!state.isPlaying;
    const nKey = `native|${nPlaying}|${nName}|${nSub}`;
    if (!force && state.lastNativeReported === nKey) return;
    state.lastNativeReported = nKey;
    state.hasReportedAnyPlayback = true;
    try {
      window.NativeRadio.reportMeta && window.NativeRadio.reportMeta(nName, nSub, nPlaying);
    } catch (e) { console.warn('native report err', e); }
    return;
  }
  const ch = state.currentChannel;
  if (!ch) {
    if (!state.hasReportedAnyPlayback) return;
    if (force || state.lastNativeReported !== 'stopped') {
      state.lastNativeReported = 'stopped';
      try { window.NativeRadio.reportStopped && window.NativeRadio.reportStopped(); } catch (e) {}
    }
    return;
  }
  const name = ch.name || '';
  const sub = (ch.frequency || '') + (ch.description ? ' · ' + ch.description : '');
  const playing = !!state.isPlaying;
  const key = `${playing}|${name}|${sub}`;
  if (!force && state.lastNativeReported === key) return;
  state.lastNativeReported = key;
  state.hasReportedAnyPlayback = true;
  try {
    window.NativeRadio.reportMeta && window.NativeRadio.reportMeta(name, sub, playing);
  } catch (e) { console.warn('native report err', e); }
}

function setupPowerOptimization() {
  // ═══════════════════════════════════════════════════════════════════════
  // V159 POWER: 统一CSS动画开关 —— 只有「前台可见 && 正在播放」才运行动画，否则暂停省GPU
  //   控制元素：.fp-dot（播放指示灯脉冲）、.fp-logo-inner（封面旋转）、.card-logo img（列表卡片封面旋转）
  //   挂到 window 上，updatePlayerUI() 播放/暂停切换时能即时同步状态
  // ═══════════════════════════════════════════════════════════════════════
  window._applyAnimationsState = function() {
    try {
      const running = !document.hidden && state && state.isPlaying;
      document.querySelectorAll('.fp-dot, .fp-logo-inner, .card-logo img').forEach(el => { el.style.animationPlayState = running ? '' : 'paused'; });
    } catch(e) {}
  };
  const onVis = () => {
    const hidden = document.hidden || document.visibilityState !== 'visible';
    document.documentElement.classList.toggle('app-hidden', hidden);
    if (hidden) {
      // V159: 后台 → 无论播不播，用户都看不见 → 立刻暂停所有CSS动画
      window._applyAnimationsState && window._applyAnimationsState();
    } else {
      // V154+V159: 前台 → 延迟3秒等音频路由稳定再恢复，只在播放时才启动动画
      setTimeout(function() { try { window._applyAnimationsState && window._applyAnimationsState(); } catch(ign){} }, 3000);
    }
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('blur', onVis);
  window.addEventListener('pagehide', onVis);
  window.addEventListener('focus', () => { document.documentElement.classList.remove('app-hidden'); });

  // ═══════════════════════════════════════════════════════════════════════
  // V154 锁屏恢复逻辑（解锁卡顿优化版）
  //
  //  核心修复：解锁瞬间卡顿几率 > 锁屏无声几率
  //    → 所有非关键操作全部延后，让音频输出先稳定！
  //
  //  改动：
  //   1. 解锁恢复检查：1s → 2.5s（等媒体路由切换稳定）
  //   2. CSS动画恢复：立即 → 3s（避免与音频抢CPU）
  //   3. 解锁冷却期：10s内Watchdog不做RPC（防止误判媒体路由切换为"暂停"）
  //   4. native 正常在播时什么都不做（不更新UI、不重设isPlaying、不重绘）
  // V159 FIX: 添加 _userPaused 标志，用户主动暂停时不自动恢复（防止看门狗干扰用户操作）
  // ═══════════════════════════════════════════════════════════════════════
  let _unlockRecoveryBusy = false;
  let _watchdogTimer = null;
  let _hiddenSince = 0;          // 页面隐藏的时间戳
  let _watchdogFailCount = 0;    // 连续检测到异常的次数
  let _justUnlockedAt = 0;       // 解锁完成的时间戳（冷却期10s）
  let _userPaused = false;       // V159: 用户主动暂停标志，true时不自动恢复
  window._getUserPaused = () => _userPaused;   // 供外部读取
  window._setUserPaused = (v) => { _userPaused = v; };  // 供外部设置
  // V171 BT-AUDIO: 蓝牙音频输出丢失标志。
  //   true=蓝牙已断开，解锁屏幕/看门狗均不自动恢复；只有蓝牙重连才清除。
  //   由 Java 端 registerBtAudioMonitor() 通过 evaluateJavascript 调用 handleBtAudioDisconnect/Reconnect 设置。
  //   用户主动播放（togglePlay/playChannel）也会清除，尊重用户意图。
  let _btAudioDisconnected = false;
  window._getBtAudioDisconnected = () => _btAudioDisconnected;
  window._setBtAudioDisconnected = (v) => { _btAudioDisconnected = !!v; };

  function checkAndResumePlayback() {
    if (_unlockRecoveryBusy) return;
    if (!state.currentChannel || !state.currentChannel.url) return;
    // V159 FIX: 用户主动暂停时不自动恢复（防止看门狗干扰用户操作）
    if (_userPaused) { console.log('[V159-RECOVER] 用户主动暂停，跳过自动恢复'); return; }
    // V171 BT-AUDIO: 蓝牙断开期间不自动恢复，等重连
    //   双重检查：JS 标志(_btAudioDisconnected) + RPC status 字段(btAudioDisconnected)
    //   原因：锁屏时 WebView 可能冻结，evaluateJavascript 不执行 → JS 标志未设置
    //   但 RPC(shouldInterceptRequest) 不受冻结影响，Java 端 btAudioDisconnected 标志准确
    if (_btAudioDisconnected) { console.log('[V171-BT-RECOVER] 蓝牙音频已断开(JS标志)，跳过自动恢复'); return; }
    _unlockRecoveryBusy = true;
    try {
      if (hasNativeAudio() && state.playbackEngine === 'native') {
        try {
          var st = nativeAudioRpc('status');
          // V171 BT-AUDIO: 通过 RPC status 检查 Java 端蓝牙标志（防止 JS 标志因冻结未同步）
          if (st && st.btAudioDisconnected) {
            _btAudioDisconnected = true;
            _userPaused = true;
            console.log('[V171-BT-RECOVER] RPC status 返回 btAudioDisconnected=true，同步 JS 标志，跳过恢复');
            if (els.fpStatus) els.fpStatus.textContent = '蓝牙断开，已暂停';
            updatePlayerUI();
            return;
          }
          if (st && st.hasSource && !st.isPlaying) {
            console.log('[V154-RECOVER] native 有源但暂停，尝试 resume');
            var resp = nativeAudioRpc('resume');
            state.isPlaying = resp ? !!resp.isPlaying : true;
            if (els.fpStatus) els.fpStatus.textContent = '正在直播';
            updatePlayerUI();
          } else if (st && !st.hasSource) {
            console.log('[V154-RECOVER] native 无源，重新 playChannel');
            if (els.fpStatus) els.fpStatus.textContent = '恢复播放中...';
            playChannel(state.currentChannel);
          }
          // st.isPlaying === true → 完全什么都不做！不重绘不设值（否则会卡）
        } catch(e) {
          try { nativeAudioRpc('resume'); } catch(ign){}
        }
      } else if (state.playbackEngine === 'web' && state.audioElement) {
        if (state.isPlaying && state.audioElement.paused) {
          state.audioElement.play().catch(function() {});
        }
      }
    } catch(e) {} finally {
      _unlockRecoveryBusy = false;
    }
  }

  // visibilitychange → 只在页面隐藏超过10秒后恢复时才触发
  document.addEventListener('visibilitychange', function onVisibilityForPlayback() {
    if (document.hidden) {
      _hiddenSince = Date.now();
    } else {
      var hiddenDuration = _hiddenSince ? Date.now() - _hiddenSince : 0;
      _hiddenSince = 0;
      // V154 标记解锁冷却期（10s内watchdog不做RPC）
      _justUnlockedAt = Date.now();
      if (hiddenDuration > 10000) {
        // V154 1s → 2.5s，先等媒体路由切换稳定
        setTimeout(checkAndResumePlayback, 2500);
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // V159 Watchdog：功耗优化 —— 真正双档 Interval（前台省CPU/后台不断流）
  //
  //   后台息屏 (hidden=true)  + playing → 15s 严格检查（连续2次失败才恢复，防160s断流）
  //   前台可见 (hidden=false) + playing → 60s 粗检查（前台系统不会冻结，减少75% evaluateJavascript）
  //   未播放 / 非native引擎 → 最轻量判断、不做 nativeAudioRpc（接近零开销）
  //   解锁冷却期 10s 内全部跳过
  // ═══════════════════════════════════════════════════════════════════════
  var _bgWd = null; // 后台 15s
  var _fgWd = null; // 前台 60s

  function _wdTick(kind) {
    if (_justUnlockedAt && (Date.now() - _justUnlockedAt) < 10000) return;
    if (_userPaused) { _watchdogFailCount = 0; return; }  // V159: 用户主动暂停时不做恢复检查
    // V171 BT-AUDIO: 蓝牙断开期间不做恢复检查（等重连）
    if (_btAudioDisconnected) { _watchdogFailCount = 0; return; }
    if (!state.currentChannel || !state.isPlaying) { _watchdogFailCount = 0; return; }
    if (state.playbackEngine !== 'native' || !hasNativeAudio()) { _watchdogFailCount = 0; return; }
    try {
      var st = nativeAudioRpc('status');
      // V171 BT-AUDIO: watchdog 也通过 RPC 检查蓝牙状态（防止 JS 标志因冻结未同步）
      if (st && st.btAudioDisconnected) {
        _btAudioDisconnected = true;
        _userPaused = true;
        _watchdogFailCount = 0;
        console.log('[V171-BT-WD] RPC status 返回 btAudioDisconnected=true，同步 JS 标志，跳过恢复');
        if (els.fpStatus) els.fpStatus.textContent = '蓝牙断开，已暂停';
        updatePlayerUI();
        return;
      }
      if (st && st.hasSource && !st.isPlaying) {
        _watchdogFailCount++;
        var threshold = kind === 'bg' ? 2 : 1;
        if (_watchdogFailCount >= threshold) {
          console.log('[V159-WD-'+kind+'] failCount>=threshold → resume');
          var resp = nativeAudioRpc('resume');
          if (resp && resp.isPlaying) {
            state.isPlaying = true;
            if (els.fpStatus) els.fpStatus.textContent = '正在直播';
            updatePlayerUI();
          } else {
            playChannel(state.currentChannel);
          }
          _watchdogFailCount = 0;
        }
      } else { _watchdogFailCount = 0; }
    } catch(e) { _watchdogFailCount = 0; }
  }
  function _applyWdByVis() {
    try {
      if (document.hidden) {
        if (!_bgWd) _bgWd = setInterval(function() { _wdTick('bg'); }, 15000);
        if (_fgWd)  { clearInterval(_fgWd); _fgWd = null; }
      } else {
        if (!_fgWd) _fgWd = setInterval(function() { _wdTick('fg'); }, 60000);
        if (_bgWd)  { clearInterval(_bgWd); _bgWd = null; }
      }
    } catch(e) {}
  }
  // 启动期不启用（避免初始化时一堆JS抢占CPU），15s后再挂
  setTimeout(function() {
    _applyWdByVis();
    document.addEventListener('visibilitychange', _applyWdByVis);
  }, 15000);
  window.addEventListener('nativeRadio', (e) => {
    const type = e && e.detail ? e.detail.type : null;
    if (!type) return;
    console.log('[nativeRadio] event=' + type);
    switch (type) {
      case 'play':
        // V175 FIX(冷启动音箱播放键无声): 判断native不能用 state.playbackEngine==='native'！
        //   冷启动时从未播放过，playbackEngine 还是初始值 'web'（只有 playChannel 成功后才切 'native'），
        //   但 native RPC 已就绪(hasNativeAudio()=true)。旧条件导致：native分支被跳过、web分支的
        //   audioElement 又无 src → 收到 PLAY 却无声。native app 里 RPC 可用即走 native（优先级高于web）。
        if (hasNativeAudio()) {
          try {
            var _ps = nativeAudioRpc('status');
            var _ch = state.currentChannel || window.__lastPlayChannel;
            if (_ps && _ps.hasSource) {
              nativeAudioRpc('resume');
              state.isPlaying = true;
              window._setUserPaused && window._setUserPaused(false);
              window._setBtAudioDisconnected && window._setBtAudioDisconnected(false);
              setLastPlayPlaying(true);  // V183: 外部播放键恢复 → 播放意愿
              console.log('[nativeRadio-V175] external PLAY → native resume');
            } else if (_ch && _ch.url) {
              // 冷启动/无源：用上次电台(或当前电台)重新加载播放
              console.log('[nativeRadio-V175] external PLAY no-source → playChannel(' + (_ch.name||'') + ')');
              state.currentChannel = _ch;
              window._setUserPaused && window._setUserPaused(false);
              window._setBtAudioDisconnected && window._setBtAudioDisconnected(false);
              playChannel(_ch);
              break;
            } else {
              // 无任何电台记忆 → 播当前列表第一个（与屏幕 togglePlay 兜底一致）
              var _chs = (typeof getFilteredChannels === 'function') ? getFilteredChannels() : [];
              if (_chs.length) {
                console.log('[nativeRadio-V175] external PLAY no-channel → first station');
                window._setUserPaused && window._setUserPaused(false);
                playChannel(_chs[0]);
              }
              break;
            }
            if (els.fpStatus) els.fpStatus.textContent = '正在直播';
            updatePlayerUI();
            try { reportNativeState(); } catch(ign){}
          } catch(e) { console.warn('[nativeRadio-V175] external PLAY failed:', e && e.message); }
        } else if (state.playbackEngine === 'web' && state.currentChannel && state.audioElement) {
          state.audioElement.play().catch((err) => { console.warn('[nativeRadio] play() catch:', err && err.message ? err.message : err); });
          state.isPlaying = true; updatePlayerUI();
        }
        break;
      case 'pause':
        // V183: 蓝牙断开引起的内部暂停镜像（Java pauseForBt 带bt标记；或JS断开流程自己RPC pause时
        //   _btAudioDisconnected已置位）→ 绝不当作用户主动暂停：保留wasPlaying播放意愿、
        //   不设_userPaused（标志/UI由handleBtAudioDisconnect统一处理），只静默同步播放态。
        if ((e.detail && e.detail.bt) ||
            (window._getBtAudioDisconnected && window._getBtAudioDisconnected())) {
          console.log('[nativeRadio-V183] pause 来自蓝牙断开 → 保留播放意愿，跳过用户暂停副作用');
          state.isPlaying = false;
          try { updatePlayerUI(); } catch(ign){}
          break;
        }
        // V175: 同样用 hasNativeAudio() 判断（native优先），不依赖 playbackEngine 标志
        if (hasNativeAudio()) {
          try {
            nativeAudioRpc('pause');
            state.isPlaying = false;
            window._setUserPaused && window._setUserPaused(true);
            setLastPlayPlaying(false);  // V183: 用户(媒体键/通知栏)主动暂停 → 取消冷启动自动续播
            console.log('[nativeRadio-V175] external PAUSE → native pause');
            if (els.fpStatus) els.fpStatus.textContent = '已暂停';
            updatePlayerUI();
            try { reportNativeState(); } catch(ign){}
          } catch(e) { console.warn('[nativeRadio-V175] external PAUSE failed:', e && e.message); }
        } else if (state.playbackEngine === 'web' && state.audioElement) {
          state.audioElement.pause();
          state.isPlaying = false; updatePlayerUI();
          setLastPlayPlaying(false);  // V183
        }
        break;
      case 'stop':
        stopPlaying({ fromNativeBroadcast: true });
        break;
      case 'next':
        nextChannel();
        break;
      case 'prev':
        prevChannel();
        break;
      case 'nativePlaybackError':
        try { showToast('原生模块通知错误，当前使用Web引擎播放'); } catch(ign){}
        break;
    }
  });
}

function init() {
  try {
    // V63 BOOT LOG (safe, no DOM write yet)
    try {
      console.log('[APP BOOT] ' + APP_VERSION + ' data_ver=' + DATA_VERSION + ' isNative=' + !!isNativeApp + ' ua=' + String(navigator.userAgent||'').substr(0,120));
      const hasHls = typeof Hls !== 'undefined';
      if (hasHls) console.log('[APP BOOT] hls.js loaded: v' + (Hls.version||'?') + ' isSupported=' + Hls.isSupported());
      else console.log('[APP BOOT] Hls UNDEFINED / NOT LOADED');
      // ════════════════════════════════════════════════════════════
      // V118 NativeAudio可用性确认 — 通过 shouldInterceptRequest RPC 通道
      //   addJavascriptInterface 在 ColorOS 失效 (window.NativeAudio=undefined)
      //   改用 window.__NATIVE_AUDIO_READY 标志 (由 Java evaluateJavascript 设置)
      //   playChannel 每次调用 hasNativeAudio() 重新检查，不缓存
      const rpcReady = !!window.__NATIVE_AUDIO_READY;
      console.log('[APP BOOT] NativeAudio RPC: window.__NATIVE_AUDIO_READY=' + rpcReady
                  + ' → Native ExoPlayer V118引擎：' + (rpcReady ? '✅ RPC READY' : '⏳ 等待Java注入 (playChannel会重新检查)'));
      // ════════════════════════════════════════════════════════════
      // V168: 恢复数据/location.reload()后，原生ExoPlayer可能残留上一页的播放(孤儿流)
      //   → 启动时停掉，防止与新点击的台双声。冷启动时进程重建无残留，此调用为无害空操作。
      // V170: 播放器是进程级单例，锁屏被ColorOS销毁Activity后它仍在播放(!)。
      //   此时若盲目stop → 锁屏存活的播放被误杀，解锁后还要重播(旧bug「锁屏无声」)。
      //   规则：status.isPlaying=true 说明播放合法存活 → 保留并同步UI；否则才stop(防reload双声)。
      // ════════════════════════════════════════════════════════════
      if (rpcReady) {
        setTimeout(function() {
          try {
            var _bst = nativeAudioRpc('status');
            if (_bst && _bst.isPlaying) {
              state.playbackEngine = 'native';
              state.isPlaying = true;
              window.__lastPlayChannel = state.currentChannel || window.__lastPlayChannel;
              if (els.fpStatus) els.fpStatus.textContent = '正在直播';
              try { updatePlayerUI(); } catch(ign){}
              console.log('[V170-BOOT] 原生播放器存活且正在播放(Activity重建/锁屏恢复)，保留播放不打断 hasSource=' + _bst.hasSource);
            } else {
              nativeAudioRpc('stop');
              console.log('[V168-BOOT] 原生未在播放，执行stop清理残留(reload防双声)');
            }
          } catch(ign){}
        }, 300);
      }
      // ════════════════════════════════════════════════════════════
    } catch(ign){}
    initElements();
    // V82: 版本号移到"管理→关于"，不再弹启动Toast
    // V63: VISUAL TOAST ONLY AFTER initElements() GUARANTEES els.toast EXISTS!
    // (Before v63: showToast BEFORE initElements → els.toast=undefined → TypeError → init() aborted silently)
    // try {
    //   showToast('APP ' + APP_VERSION + ' DATA=' + DATA_VERSION);
    //   clearTimeout(showToast._t);
    //   showToast._t = setTimeout(()=>{ try { if (els && els.toast) els.toast.classList.remove('show'); } catch(ign){} }, 8000);
    // } catch(ign){}
    setupPowerOptimization();
    initTheme();
    initFont();
    loadChannels();
    loadFavorites();
    loadHistory();
    loadCustomChannels();
    loadUserStations();
    // ---- 恢复最后播放状态：先于自动定位，以免定位覆盖 currentFilter ----
    try {
      const lp = loadLastPlay();
      if (lp && lp.id) {
        // 2. 先找 channel 对象，找到后才能确定它实际的分类
        let ch = null;
        if (lp.isUserStation) {
          ch = state.userStations.find(s => s.id === lp.id);
          if (ch) ch = { ...ch, isUserStation: true };
        }
        if (!ch) {
          const all = [...(state.channels.radio||[]), ...(state.channels.tv||[])];
          ch = all.find(c => c.id === lp.id);
        }
        // 如果找不到（数据变了），就用保存的信息构造一个
        if (!ch && lp.url) {
          ch = {
            id: lp.id, name: lp.name, url: lp.url,
            description: lp.description, category: lp.category,
            frequency: lp.frequency, color: lp.color,
            isUserStation: !!lp.isUserStation
          };
        }
        if (ch) {
          state.currentChannel = ch;
          // V141: 优先恢复上次保存的 lp.filter（用户当时在看哪个 tab），
          //   前提是该 tab 里确实能看到这个电台（收藏/历史/自定义/省份都行）；
          //   如果 lp.filter 不匹配（比如收藏已移除），才回退到电台实际省份。
          const cats = getCategoryList();
          const actualCat = String(ch.description || ch.category || '').trim();
          let filterToUse = '';
          if (lp.filter && cats.indexOf(lp.filter) >= 0) {
            // 验证该电台是否真的出现在这个 filter 的列表里
            var inThisFilter = false;
            if (lp.filter === '收藏') {
              inThisFilter = state.favorites.indexOf(ch.id) >= 0;
            } else if (lp.filter === '历史') {
              // V163修复: history存的是id字符串数组，原some(h=>h.id)永远false → 冷启动总是回落到省份
              inThisFilter = state.history.indexOf(ch.id) >= 0;
            } else if (lp.filter === '自定义') {
              inThisFilter = state.customChannels.indexOf(ch.id) >= 0;
            } else if (lp.filter === '个人') {
              // V162: 个人tab → 检查是否为用户自建电台（个人电台地区可能是任意省份，不能用actualCat匹配）
              inThisFilter = state.userStations.some(s => s.id === ch.id) || !!ch.isUserStation;
            } else {
              // 省份/全部：用电台实际分类匹配
              inThisFilter = (lp.filter === '全部') || (actualCat === lp.filter);
            }
            if (inThisFilter) filterToUse = lp.filter;
          }
          if (!filterToUse && actualCat && cats.indexOf(actualCat) >= 0) {
            filterToUse = actualCat;          // 兜底：电台实际所在的省份
          }
          if (filterToUse) { state.currentFilter = filterToUse; console.log('[V163 lastPlay恢复] lp.filter=' + (lp.filter||'') + ' → filter=' + filterToUse + ' 电台=' + (ch.name||'') + ' isUserStation=' + !!ch.isUserStation); }
          // V138: 为 init 末尾的"滚动到当前电台"打一个需要滚动的标记
          window.__INIT_SCROLL_NEEDED = { id: ch.id, name: ch.name };
        }
      }
    } catch(e) {}
    initAnalogClock();
    renderCategories();
    renderChannels();
    updateTopRegion();
    updatePlayerUI();
    setupEventListeners();
    initLandscapeVU(); // V191 横屏双声道机械 VU 表
    setupThemeSwitcher();
    setupFontSwitcher();
    setupLocateBtn();
    setupAudio();
    initNativeAudioListener_once();
    reportNativeState(true);
    startMiniProgressTicker();
    autoDetectProvinceOnLaunch();
    // V138: 所有 DOM 都渲染好后，再滚动一次到当前电台（启动时 pinnedProvince 排序、分类切换都已完成）
    //       用 requestAnimationFrame 两次确保下一帧 paint 后再滚动，避免被 renderChannels 末尾的"smooth scroll"覆盖
    try {
      if (window.__INIT_SCROLL_NEEDED && state.currentChannel) {
        var sn = window.__INIT_SCROLL_NEEDED;
        var doScroll = function() {
          try {
            var curId = sn.id;
            var curName = sn.name;
            var activeEl = null;
            if (els.channelList) {
              var allItems = els.channelList.querySelectorAll('.channel-list-item');
              for (var i = 0; i < allItems.length; i++) {
                var fav = allItems[i].querySelector('.channel-list-fav');
                if (fav && fav.getAttribute('data-id') == curId) { activeEl = allItems[i]; break; }
              }
              if (!activeEl && curName) {
                var nms = els.channelList.querySelectorAll('.channel-list-name');
                for (var k = 0; k < nms.length; k++) {
                  if (nms[k].textContent === curName) {
                    activeEl = nms[k].closest('.channel-list-item');
                    break;
                  }
                }
              }
            }
            if (activeEl) {
              // 对齐到顶部（像用户截图那样："BTV生活伴音"正好在列表最上面），block:'start' + 一点 padding 偏移
              activeEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
              // 再补一次：如果顶栏/搜索栏遮住了，再微调一次（setTimeout 100ms）
              setTimeout(function(){
                try {
                  if (els.channelList) {
                    var pad = 110; // 顶部时钟+标题区高度，让item不要贴在最顶端（和截图里"BTV生活伴音"在第二格的位置一致）
                    var y = activeEl.getBoundingClientRect().top + els.channelList.scrollTop - pad;
                    els.channelList.scrollTo({ top: y, behavior: 'smooth' });
                  }
                } catch(e){}
              }, 350);
            }
          } catch (ex) { console.warn('INIT_SCROLL_NEEDED ex', ex && ex.message); }
        };
        window.requestAnimationFrame(function(){
          window.requestAnimationFrame(doScroll);
        });
      }
    } catch (scrollInitEx) { console.warn('scrollInit wrapper ex', scrollInitEx && scrollInitEx.message); }
    // V152: 渲染进程崩溃恢复检测 — 如果上次是渲染崩溃恢复，强制重连播放
    try { checkRenderCrashRecovery(); } catch(e) { console.warn('checkRenderCrashRecovery ex', e); }
    // V183: 冷启动自动续播（wasPlaying + 外部音频输出门控；无输出则布防等耳机连接）
    try { coldResumeIfNeeded(); } catch(e) { console.warn('coldResumeIfNeeded ex', e); }
  } catch (e) {
    const msg = '[init.err] ' + (e && e.message ? e.message : String(e)) + (e && e.stack ? '\n' + String(e.stack).slice(0, 400) : '');
    console.error(msg);
    try {
      const body = document.body || document.documentElement;
      const div = document.createElement('div');
      div.style.cssText = 'position:fixed;inset:12px;z-index:99999;background:#1a0000;color:#ffc9c9;padding:14px 16px;border:1px solid #e03131;border-radius:12px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre-wrap;';
      div.textContent = msg;
      body.appendChild(div);
    } catch (fatal) { /* swallow */ }
  }
}

window.addEventListener('error', (ev) => {
  try {
    var rawMsg = String(ev.message == null ? '' : ev.message);
    var lower = rawMsg.toLowerCase();
    var fn = String(ev.filename == null ? '' : ev.filename);
    var fnLower = fn.toLowerCase();
    var ln = typeof ev.lineno === 'number' ? ev.lineno : 0;
    var co = typeof ev.colno === 'number' ? ev.colno : 0;
    var hasErrorObj = !!(ev.error && (typeof ev.error.stack === 'string' || typeof ev.error.message === 'string'));

    var fromOurCode = (
      fnLower.indexOf('app.js') >= 0 ||
      fnLower.indexOf('channels.js') >= 0 ||
      fnLower.indexOf('index.html') >= 0 ||
      fnLower.indexOf('localhost') >= 0 && (fnLower.indexOf('app') >= 0 || fnLower.indexOf('channel') >= 0)
    );

    var looksLikeCorsNoise = (
      lower.indexOf('script error') === 0 &&
      (!fn || fn === '' || fromOurCode === false || ln === 0 || !hasErrorObj)
    );

    var fromHls = (fnLower.indexOf('hls.js') >= 0);
    var isNoise = looksLikeCorsNoise || fromHls;

    var msg = '[win.err] ' + rawMsg + (fn ? ' @ ' + fn + ':' + ln + ':' + co : '');
    if (isNoise) {
      console.warn('[win.err.ignored]', msg, ev.error);
      return;
    }
    console.error(msg, ev.error);

    var body = document.body || document.documentElement;
    if (!body.querySelector('.js-global-err')) {
      var div = document.createElement('div');
      div.className = 'js-global-err';
      div.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;background:#1a0000;color:#ffc9c9;padding:10px 12px;border:1px solid #e03131;border-radius:10px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;max-height:40vh;';
      var lines = [];
      lines.push(msg);
      lines.push('---- diag ----');
      lines.push('message.len=' + rawMsg.length);
      try { lines.push('message.repr=' + JSON.stringify(rawMsg)); } catch (e) { lines.push('message.repr=<encode fail>'); }
      try { lines.push('filename=' + JSON.stringify(fn)); } catch (e) { lines.push('filename=<encode fail>'); }
      lines.push('lineno=' + ln + ' colno=' + co);
      lines.push('hasErrorObj=' + (hasErrorObj ? 'Y' : 'N'));
      lines.push('fromOurCode=' + (fromOurCode ? 'Y' : 'N'));
      if (hasErrorObj && ev.error && typeof ev.error.stack === 'string') {
        try { lines.push('error.stack=' + ev.error.stack.slice(0, 260)); } catch (e) { lines.push('error.stack=<slice fail>'); }
      } else {
        lines.push('error.stack=-');
      }
      div.textContent = lines.join('\n');
      body.appendChild(div);
    }
  } catch (outerFatal) {
    try { console.error('onerror.fatal', outerFatal); } catch (e) {}
  }
});
window.addEventListener('unhandledrejection', (ev) => {
  try {
    var r = (ev && typeof ev.reason !== 'undefined') ? ev.reason : null;
    var msgRaw = '';
    if (r && typeof r.message === 'string') msgRaw = r.message;
    else if (r != null) msgRaw = String(r);
    var lower = msgRaw.toLowerCase();
    var stackStr = (r && typeof r.stack === 'string') ? r.stack.toLowerCase() : '';
    var isNoise = (
      (lower.indexOf('script error') === 0) ||
      (lower.indexOf('hls') >= 0 && (lower.indexOf('network') >= 0 || lower.indexOf('load') >= 0)) ||
      lower.indexOf('abort') >= 0 || lower.indexOf('cancel') >= 0 ||
      (lower.indexOf('media') >= 0 && lower.indexOf('network') >= 0) ||
      (stackStr.indexOf('hls') >= 0)
    );
    if (isNoise) { console.warn('[promise.err.ignored]', msgRaw); return; }
    console.error('[promise.err]', msgRaw, r);
  } catch (outerFatal) {
    try { console.error('unhandled.fatal', outerFatal); } catch (e) {}
  }
});

/* ============ 模拟指针时钟（纯SVG viewBox=100x100 绝对坐标，零错位） ============ */
function initAnalogClock() {
  const ticksEl = document.getElementById('macTicks');
  const numsEl  = document.getElementById('macNumbers');
  // ---- SVG 刻度 ----
  if (ticksEl) {
    ticksEl.innerHTML = '';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < 60; i++) {
      const angleDeg = i * 6;
      const rad = angleDeg * Math.PI / 180;
      const isHour = (i % 5 === 0);
      const rIn  = isHour ? 38.2 : 41.5;
      const rOut = 45.2;
      const x1 = 50 + rIn  * Math.sin(rad);
      const y1 = 50 - rIn  * Math.cos(rad);
      const x2 = 50 + rOut * Math.sin(rad);
      const y2 = 50 - rOut * Math.cos(rad);
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', x1.toFixed(2));
      line.setAttribute('y1', y1.toFixed(2));
      line.setAttribute('x2', x2.toFixed(2));
      line.setAttribute('y2', y2.toFixed(2));
      line.setAttribute('stroke', isHour ? '#2a1b07' : '#5a3d12');
      line.setAttribute('stroke-width', isHour ? '1.65' : '0.75');
      line.setAttribute('stroke-linecap', 'round');
      ticksEl.appendChild(line);
    }
  }
  // ---- SVG 12数字（绝对坐标，居中文本锚点） ----
  if (numsEl) {
    numsEl.innerHTML = '';
    const SVG_NS = 'http://www.w3.org/2000/svg';
    for (let i = 1; i <= 12; i++) {
      const angleDeg = i * 30;
      const rad = angleDeg * Math.PI / 180;
      const radius = 32.0; // 距圆心32（viewBox=100，外径46.5）
      const x = 50 + radius * Math.sin(rad);
      const y = 50 - radius * Math.cos(rad);
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', x.toFixed(2));
      t.setAttribute('y', y.toFixed(2));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('dominant-baseline', 'central');
      t.setAttribute('fill', '#1f1303');
      t.setAttribute('font-size', i < 10 ? '6.2' : '5.9');
      t.setAttribute('letter-spacing', '-0.3');
      t.textContent = String(i);
      numsEl.appendChild(t);
    }
  }
  updateAnalogClock();
  // V164 POWER: 锁屏/后台时停掉每秒时钟定时器（原来仅跳过秒针绘制，但每秒仍唤醒CPU）。
  //   回前台时立即刷新一次并重启定时器，指针无感知差异。
  let _clockTimer = setInterval(updateAnalogClock, 1000);
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      if (_clockTimer) { clearInterval(_clockTimer); _clockTimer = null; }
    } else {
      if (!_clockTimer) _clockTimer = setInterval(updateAnalogClock, 1000);
      updateAnalogClock();
    }
  });
}

function updateAnalogClock() {
  const now = new Date();
  const h = now.getHours() % 12;
  const m = now.getMinutes();
  const s = now.getSeconds();
  const hourDeg = h * 30 + m * 0.5;
  const minDeg  = m * 6 + s * 0.1;
  const secDeg  = s * 6;
  const he = document.getElementById('macHour');
  const me = document.getElementById('macMinute');
  const se = document.getElementById('macSecond');
  // SVG pointer-events rotate around center (50,50)
  if (he) he.setAttribute('transform', `rotate(${hourDeg} 50 50)`);
  if (me) me.setAttribute('transform', `rotate(${minDeg} 50 50)`);
  // V159 POWER: 后台息屏时用户看不见 → 跳过秒针setAttribute（省2/3的DOM写入）
  if (se && !document.hidden) se.setAttribute('transform', `rotate(${secDeg} 50 50)`);
}

function initElements() {
  try {
    // Remove any V64/V63 giant debug overlay left over from prior versions.
    var ov = document.getElementById('v64DebugOverlay');
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  } catch(e){}
  els.searchBtn = $('searchBtn');
  els.timerTopBtn = $('timerTopBtn');
  els.topRegion = $('topRegion');

  els.sideNav = $('sideNav');
  els.channelList = $('channelList');
  els.emptyState = $('emptyState');

  els.miniPlayer = $('miniPlayer');
  els.miniLeft = $('miniLeft');
  els.miniName = $('miniName');
  els.miniSub = $('miniSub');
  els.miniPrev = $('miniPrev');
  els.miniPlay = $('miniPlay');
  els.miniPlayIcon = $('miniPlayIcon');
  els.miniNext = $('miniNext');
  els.miniFav = $('miniFav');
  els.miniLine = $('miniLine');
  els.miniTimeStart = $('miniTimeStart');
  els.miniTimeEnd = $('miniTimeEnd');
  els.miniProgressFill = $('miniProgressFill');
  els.miniProgressThumb = $('miniProgressThumb');
  els.miniTimerBtn = $('miniTimerBtn');
  els.fpMenu = $('fpMenu');

  els.fullPlayer = $('fullPlayer');
  els.fpBg = $('fpBg');
  els.fpClose = $('fpClose');
  els.fpStatus = $('fpStatus');
  els.fpLogoInner = $('fpLogoInner');
  els.fpName = $('fpName');
  els.fpSub = $('fpSub');
  els.fpPlay = $('fpPlay');
  els.fpPlayIcon = $('fpPlayIcon');
  els.fpPrev = $('fpPrev');
  els.fpNext = $('fpNext');
  els.fpFav = $('fpFav');
  els.fpTimer = $('fpTimer');
  els.fpVolume = $('fpVolume');

  els.bottomTabs = document.querySelectorAll('.tab-item');

  els.searchSheet = $('searchSheet');
  els.searchInput = $('searchInput');
  els.searchClear = $('searchClear');
  els.searchClose = $('searchClose');
  els.searchResults = $('searchResults');
  // V150: 搜索历史
  els.searchHistory = $('searchHistory');
  els.searchHistoryTags = $('searchHistoryTags');
  els.searchHistoryClear = $('searchHistoryClear');

  els.modalSheet = $('modalSheet');
  els.sheetTitle = $('sheetTitle');
  els.sheetClose = $('sheetClose');
  els.addChannelBtn = $('addChannelBtn');
  els.exportBtn = $('exportBtn');
  els.importBtn = $('importBtn');
  els.resetBtn = $('resetBtn');
  els.backupBtn = $('backupBtn');
  els.restoreBtn = $('restoreBtn');
  els.channelManageList = $('channelManageList');
  els.manageRegionTabs = $('manageRegionTabs');
  els.manageRegionSummary = $('manageRegionSummary');
  els.manageRegionCurrent = $('manageRegionCurrent');
  els.logoProgressSection = $('logoProgressSection');
  els.progressFetched = $('progressFetched');
  els.progressFailed = $('progressFailed');
  els.progressTotal = $('progressTotal');
  els.progressFill = $('progressFill');
  els.fetchLogoBtn = $('fetchLogoBtn');

  els.themeSwitcher = $('themeSwitcher');
  els.themeBtns = document.querySelectorAll('.theme-btn');

  els.fontSwitcher = $('fontSwitcher');
  els.fontBtns = document.querySelectorAll('.font-btn');
  els.locateBtn = $('locateBtn');
  els.locateBtnLabel = $('locateBtnLabel');
  els.locateHint = $('locateHint');

  els.editSheet = $('editSheet');
  els.editSheetTitle = $('editSheetTitle');
  els.editSheetClose = $('editSheetClose');
  els.editForm = $('editForm');
  els.editCancel = $('editCancel');

  els.timerSheet = $('timerSheet');
  els.timerSheetClose = $('timerSheetClose');
  els.timerCountdown = $('timerCountdown');

  els.personalBatchFile = $('personalBatchFile');
  els.toast = $('toast');

  els.personalSheet = $('personalSheet');
  els.personalSheetTitle = $('personalSheetTitle');
  els.personalSheetClose = $('personalSheetClose');
  els.personalForm = $('personalForm');
  els.personalCancel = $('personalCancel');

  els.batchSheet = $('batchSheet');
  els.batchSheetClose = $('batchSheetClose');
  els.batchTextarea = $('batchTextarea');
  els.batchCopyTemplate = $('batchCopyTemplate');
  els.batchClear = $('batchClear');
  els.batchImport = $('batchImport');
  els.batchCancel = $('batchCancel');
  els.batchInfo = $('batchInfo');

  els.confirmOverlay = $('confirmOverlay');
  els.confirmTitle = $('confirmTitle');
  els.confirmMsg = $('confirmMsg');
  els.confirmCancel = $('confirmCancel');
  els.confirmOk = $('confirmOk');
}

/* ============ CLOCK ============ */
function startClock() {
  function update() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2,'0');
    const m = String(now.getMinutes()).padStart(2,'0');
    els.clock.textContent = `${h}:${m}`;
  }
  update();
  // V159 POWER: 只显示HH:MM → 60秒刷新足够（之前1秒有98%的更新是重复写入相同字符串）
  setInterval(update, 60000);
}

/* ============ STORAGE ============ */
function saveChannels() { try { localStorage.setItem('radio_channels', JSON.stringify(state.channels)); } catch(e){} }
function loadFavorites() { try { state.favorites = JSON.parse(localStorage.getItem('radio_favorites')||'[]'); } catch(e){ state.favorites=[]; } }
function saveFavorites() { try { localStorage.setItem('radio_favorites', JSON.stringify(state.favorites)); } catch(e){} }
function loadHistory() { try { state.history = JSON.parse(localStorage.getItem('radio_history')||'[]'); } catch(e){ state.history=[]; } }
function saveHistory() { try { localStorage.setItem('radio_history', JSON.stringify(state.history)); } catch(e){} }
function loadCustomChannels() { try { state.customChannels = JSON.parse(localStorage.getItem('radio_custom_channels')||'[]'); } catch(e){ state.customChannels=[]; } }
function saveCustomChannels() { try { localStorage.setItem('radio_custom_channels', JSON.stringify(state.customChannels)); } catch(e){} }
function loadUserStations() { try { state.userStations = JSON.parse(localStorage.getItem('radio_user_stations')||'[]'); } catch(e){ state.userStations=[]; } }
function saveUserStations() { try { localStorage.setItem('radio_user_stations', JSON.stringify(state.userStations)); } catch(e){} }
function saveLastPlay(ch, wasPlaying) {
  try {
    if (!ch) return;
    localStorage.setItem(LAST_PLAY_KEY, JSON.stringify({
      id: ch.id,
      name: ch.name || '',
      url: ch.url || '',
      description: ch.description || '',
      category: ch.category || '',
      frequency: ch.frequency || '',
      color: ch.color || '',
      isUserStation: !!ch.isUserStation,
      filter: state.currentFilter || '全部',
      // V183: 播放意愿标记。播放/重连恢复=true；用户手动暂停/停止=false；
      //   蓝牙断开导致的暂停保持true（语义：还想听，只是设备断了），供冷启动自动续播门控使用。
      wasPlaying: wasPlaying !== false,
      ts: Date.now()
    }));
  } catch(e) {}
}
// V183: 只更新播放意愿，不改动电台信息/时间戳（暂停、resume 等轻量场景）
function setLastPlayPlaying(flag) {
  try {
    const raw = localStorage.getItem(LAST_PLAY_KEY);
    if (!raw) return;
    const lp = JSON.parse(raw);
    if (!lp) return;
    lp.wasPlaying = !!flag;
    localStorage.setItem(LAST_PLAY_KEY, JSON.stringify(lp));
  } catch(e) {}
}
function loadLastPlay() {
  try {
    const raw = localStorage.getItem(LAST_PLAY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

/* ============ Electron版 processChannels (100%字节级复制自根目录app.js第119-669行) ============ */
function processChannels(data) {
  // ============ V102d 双重防御 (V1.3.89同款BUG根因) ============
  //  旧代码致命缺陷：
  //    1. channels.js有时没tv字段 → data.tv = undefined → data.tv.length直接TypeError
  //    2. processChannels任何异常→函数崩溃→不写localStorage→forceReset+无缓存=空列表0个电台
  //  修复：函数开头就把data.radio/data.tv兜底为[]，整个函数wrap try/catch，失败返回backupStations保底（至少有1600+ backup台）
  if (!data) { console.error('V102d processChannels: data为空，兜底backupStations'); data = {radio:[], tv:[]}; }
  if (!Array.isArray(data.radio)) { console.warn('V102d processChannels: data.radio非数组，兜底=[]'); data.radio = []; }
  if (!Array.isArray(data.tv))    { console.warn('V102d processChannels: data.tv非数组，兜底=[] (this is normal if channels.js lacks tv field)'); data.tv = []; }
  try {
  const badChars = ['鏂', '缃', '鍖', '浜', '闊', '涓', '鍗', '浣', '娌', '閮', '杈', '姹', '娴', '灞', '鍝', '瑗', '榛', '瀹', '娓', '闀', '榫'];
  
  const backupStations = [
    {name:'喜马拉雅有声小说', frequency:'FM88.1', url:'https://m.ximalaya.com/radio/', region:'全国', category:'文艺'},
    {name:'蜻蜓FM新闻',       frequency:'FM91.5', url:'https://www.qingting.fm/', region:'全国', category:'新闻'},
    {name:'喜马拉雅音乐台',   frequency:'FM93.7', url:'https://www.ximalaya.com/', region:'全国', category:'音乐'},
    {name:'蜻蜓FM财经',       frequency:'FM96.4', url:'https://www.qingting.fm/channels/', region:'全国', category:'经济'},
    {name:'喜马拉雅历史',     frequency:'FM98.2', url:'https://m.ximalaya.com/', region:'全国', category:'教育'},
    {name:'CRI中国国际',      frequency:'FM99.1', url:'https://streaming.chinabroadcast.cn/chi/livestream.m3u8', region:'国际', category:'新闻'},
    {name:'China Plus',       frequency:'FM100.5', url:'https://streaming.chinabroadcast.cn/eng/livestream.m3u8', region:'国际', category:'新闻'},
    {name:'BBC World',        frequency:'FM101.8', url:'https://stream.live.vc.bbcmedia.co.uk/bbc_world_service', region:'国际', category:'新闻'},
    {name:'NPR News',         frequency:'FM103.3', url:'https://npr-ice.streamguys1.com/live-nprnews-128.mp3', region:'国际', category:'新闻'},
    {name:'SomaFM Groove',    frequency:'FM105.7', url:'https://ice1.somafm.com/groovesalad-128-mp3', region:'国际', category:'音乐'},
    {name:'CCTV1综合',        frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctv1_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'CCTV2财经',        frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctv2_2.m3u8', region:'电视伴音', category:'经济'},
    {name:'CCTV3综艺',        frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctv3_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'CCTV4国际',        frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctv4_2.m3u8', region:'电视伴音', category:'新闻'},
    {name:'CCTV-4国际美洲',   frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctvamerica_2.m3u8', region:'电视伴音', category:'新闻'},
    {name:'CCTV-4国际欧洲',   frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctveurope_2.m3u8', region:'电视伴音', category:'新闻'},
    {name:'CCTV5体育',        frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctv5_2.m3u8', region:'电视伴音', category:'体育'},
    {name:'CCTV-5+体育赛事',  frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctv5plus_2.m3u8', region:'电视伴音', category:'体育'},
    {name:'CCTV6电影',        frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctv6_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'CCTV7国防军事',    frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctv7_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'CCTV8电视剧',      frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctv8_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'CCTV9纪录',        frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctv9_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'CCTV10科教',       frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctv10_2.m3u8', region:'电视伴音', category:'教育'},
    {name:'CCTV11戏曲',       frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctv11_2.m3u8', region:'电视伴音', category:'文艺'},
    {name:'CCTV12社会与法',   frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctv12_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'CCTV13新闻',       frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/cctv13_2.m3u8', region:'电视伴音', category:'新闻'},
    {name:'CCTV14少儿',       frequency:'电视伴音', url:'https://piccpndks.v.kcdnvip.com/audio/cctv14_2/index.m3u8', region:'电视伴音', category:'影视'},
    {name:'CCTV15音乐',       frequency:'电视伴音', url:'https://piccpndks.v.kcdnvip.com/audio/cctv15_2/index.m3u8', region:'电视伴音', category:'音乐'},
    {name:'CCTV16奥林匹克',   frequency:'电视伴音', url:'https://piccpndks.v.kcdnvip.com/audio/cctv16_2/index.m3u8', region:'电视伴音', category:'体育'},
    {name:'CCTV17农业农村',   frequency:'电视伴音', url:'https://piccpndks.v.kcdnvip.com/audio/cctv17_2/index.m3u8', region:'电视伴音', category:'农村'},
    {name:'北京卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/btv1_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'重庆卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/chongqing_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'东方卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/dongfang_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'东南卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/dongnan_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'甘肃卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/gansu_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'广东卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/guangdong_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'广西卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/guangxi_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'贵州卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/guizhou_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'黑龙江卫视',       frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/heilongjiang_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'河南卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/henan_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'湖北卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/hubei_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'江西卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/jiangxi_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'辽宁卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/liaoning_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'内蒙古卫视',       frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/neimenggu_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'宁夏卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/ningxia_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'青海卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/qinghai_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'山西卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/shan1xi_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'陕西卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/shan3xi_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'山东卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/shandong_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'四川卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/sichuan_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'天津卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/tianjin_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'海南卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/travel_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'新疆卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/xinjiang_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'西藏卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/xizang_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'云南卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/yunnan_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'安徽卫视',         frequency:'电视伴音', url:'https://piccpndali.v.myalicdn.com/audio/anhui_2.m3u8', region:'电视伴音', category:'影视'},
    {name:'湖南卫视',         frequency:'电视伴音', url:'http://satellitepull.cnr.cn/live/wx32hunws/playlist.m3u8', region:'电视伴音', category:'影视'},
    {name:'深圳卫视伴音',     frequency:'电视伴音', url:'https://satellitepull.cnr.cn/live/wxszws/playlist.m3u8', region:'电视伴音', category:'影视'},
    {name:'新加坡Capital958', frequency:'FM95.8', url:'http://22403.live.streamtheworld.com:80/CAPITAL958FMAAC.aac', region:'海外', category:'新闻'},
    {name:'新加坡LOVE972',    frequency:'FM97.2', url:'http://22893.live.streamtheworld.com:80/LOVE972FMAAC.aac', region:'海外', category:'音乐'},
    {name:'新加坡YES933',     frequency:'FM93.3', url:'http://22903.live.streamtheworld.com:80/YES933AAC.aac', region:'海外', category:'音乐'},
    {name:'新加坡HAO963',     frequency:'FM96.3', url:'http://22243.live.streamtheworld.com:80/HAO_963AAC.aac', region:'海外', category:'音乐'},
    {name:'良友电台',         frequency:'网络电台', url:'https://listen.lyapp2.net:8001/ly729_a', region:'台湾', category:'新闻'},
    {name:'SMG一财电视',      frequency:'电视伴音', url:'http://a1live.livecdn.yicai.com/live/radio_tv.m3u8', region:'海外', category:'经济'},
    {name:'SMG一财广播',      frequency:'网络电台', url:'http://satellitepull.cnr.cn/live/wx32dycjgb/playlist.m3u8', region:'海外', category:'经济'},
    {name:'复兴电台',         frequency:'网络电台', url:'http://202.39.43.67:1935/live/RA000024/chunklist.m3u8', region:'台湾', category:'新闻'},
    {name:'光华之声',         frequency:'网络电台', url:'http://202.39.43.67:1935/live/RA000077/chunklist.m3u8', region:'台湾', category:'新闻'},
    {name:'台湾之音',         frequency:'网络电台', url:'https://streamak0138.akamaized.net/live0138lh-mbm9/_definst_/rti3/playlist.m3u8', region:'台湾', category:'新闻'},
    {name:'香港电台',         frequency:'网络电台', url:'https://rthkradiopth-live.akamaized.net/hls/live/2040082/radiopth/index_64_a.m3u8', region:'香港', category:'新闻'},
    {name:'新加坡958',        frequency:'FM95.8', url:'http://22403.live.streamtheworld.com:80/CAPITAL958FMAAC.aac', region:'海外', category:'新闻'},
    {name:'日本NHK2',         frequency:'网络电台', url:'https://nhkworld-radio.akamaized.net/hls/live/2115822/nhkworld-radio-rs2/index_rs2.m3u8', region:'海外', category:'新闻'},
    {name:'日本NHK1',         frequency:'网络电台', url:'https://nhkworld-radio.akamaized.net/hls/live/2115823/nhkworld-radio-rs1/index_rs1.m3u8', region:'海外', category:'新闻'},
    {name:'凤凰中文',         frequency:'网络电台', url:'http://playtv-live.ifeng.com/live/06OLEGEGM4G_audio.m3u8', region:'香港', category:'新闻'},
    {name:'凤凰资讯',         frequency:'网络电台', url:'http://playtv-live.ifeng.com/live/06OLEEWQKN4_audio.m3u8', region:'香港', category:'新闻'},
    {name:'金鹰之声',         frequency:'网络电台', url:'http://satellitepull.cnr.cn/live/wx32955/playlist.m3u8', region:'海外', category:'音乐'},
    {name:'阿基米德',         frequency:'网络电台', url:'https://lhttp-hw.qtfm.cn/live/20500182/64k.mp3', region:'海外', category:'音乐'},
    {name:'天籁国风',         frequency:'网络电台', url:'https://stream.hndt.com/live/xinwen/chunklist_w2082955562.m3u8', region:'海外', category:'音乐'},
    {name:'天籁经典',         frequency:'网络电台', url:'https://stream.hndt.com/live/gudian/chunklist_w1459369717.m3u8', region:'海外', category:'音乐'},
    {name:'天籁古典',         frequency:'网络电台', url:'http://lhttp.qingting.fm/live/20210756/64k.mp3', region:'海外', category:'音乐'},
    {name:'Fredfilm',         frequency:'网络电台', url:'https://lhttp.qtfm.cn/live/20500181/64k.mp3', region:'海外', category:'影视'},
    {name:'交响FM',           frequency:'FM98.5', url:'http://lhttp.qingting.fm/live/5022308/64k.mp3', region:'海外', category:'音乐'},
    {name:'爵士FM',           frequency:'FM99.1', url:'http://lhttp.qingting.fm/live/20207764/64k.mp3', region:'海外', category:'音乐'},
    {name:'民谣FM',           frequency:'FM99.7', url:'http://lhttp.qingting.fm/live/20207763/64k.mp3', region:'海外', category:'音乐'},
    {name:'经典FM',           frequency:'FM100.3', url:'http://lhttp.qingting.fm/live/20207762/64k.mp3', region:'海外', category:'音乐'},
    {name:'香港衛視',         frequency:'电视伴音', url:'http://zhibo.hkstv.tv/livestream/mutfysrq/playlist.m3u8', region:'香港', category:'影视'},
    {name:'TVB無線新聞',      frequency:'电视伴音', url:'https://v2hcdn.jdshipin.com/news/news.stream/chunklist_w1055.m3u8', region:'香港', category:'新闻'},
    {name:'TVB星河',          frequency:'电视伴音', url:'https://v2hcdn.jdshipin.com/xinghe_1/xinghe_1.stream/chunklist_w106.m3u8', region:'香港', category:'影视'},
    {name:'TVBS亞洲',         frequency:'电视伴音', url:'http://38.64.72.148/hls/modn/list/4005/playlist.m3u8', region:'台湾', category:'新闻'},
    {name:'東森超視34.5',     frequency:'电视伴音', url:'http://38.64.72.148/hls/modn/list/2013/playlist.m3u8', region:'台湾', category:'影视'},
    {name:'CNBC',             frequency:'网络电台', url:'https://fl2.moveonjoy.com/CNBC/index.m3u8', region:'海外', category:'经济'},
    {name:'CNBC Indonesia',   frequency:'网络电台', url:'http://live.cnbcindonesia.com/livecnbc/smil:cnbctv.smil/.m3u8', region:'海外', category:'经济'},
    {name:'FOX Sports 1',     frequency:'网络电台', url:'http://212.102.60.10/FOX_Sports_1/index.m3u8', region:'海外', category:'体育'},
    {name:'ESPN',             frequency:'网络电台', url:'http://41.205.93.154/ESPN/index.m3u8', region:'海外', category:'体育'},
    {name:'ESPN News',        frequency:'网络电台', url:'http://38.96.178.201/live/ESPNews/index.m3u8', region:'海外', category:'体育'},
    {name:'NHK World-Japan',  frequency:'网络电台', url:'https://master.nhkworld.jp/nhkworld-tv/playlist/live.m3u8', region:'海外', category:'新闻'},
    {name:'NHK総合',          frequency:'网络电台', url:'http://vthanh.utako.moe/NHK_G/index.m3u8', region:'海外', category:'新闻'},
    {name:'RTI台湾中央广播电台', frequency:'网络电台', url:'https://streamak0138.akamaized.net/live0138lh-mbm9/_definst_/rti3/chunklist.m3u8', region:'台湾', category:'新闻'},
    {name:'HK第一台',         frequency:'网络电台', url:'https://rthkradio1-live.akamaized.net/hls/live/2035313/radio1/master.m3u8', region:'香港', category:'新闻'},
    {name:'HK第二台',         frequency:'网络电台', url:'https://rthkradio2-live.akamaized.net/hls/live/2040078/radio2/master.m3u8', region:'香港', category:'音乐'},
    {name:'HK第二台2',        frequency:'网络电台', url:'https://rthkaudio2-lh.akamaihd.net/i/radio2_1@355865/master.m3u8', region:'香港', category:'音乐'},
    {name:'HK第三台2',        frequency:'网络电台', url:'https://rthkaudio3-lh.akamaihd.net/i/radio3_1@355866/master.m3u8', region:'香港', category:'音乐'},
    {name:'HK第四台',         frequency:'网络电台', url:'https://rthkradio4-live.akamaized.net/hls/live/2040080/radio4/master.m3u8', region:'香港', category:'音乐'},
    {name:'HK第五台',         frequency:'网络电台', url:'https://rthkradio5-live.akamaized.net/hls/live/2040081/radio5/master.m3u8', region:'香港', category:'新闻'},
    {name:'普通话台',         frequency:'网络电台', url:'https://rthkradiopth-live.akamaized.net/hls/live/2040082/radiopth/master.m3u8', region:'香港', category:'新闻'},
    {name:'台湾宝岛联播网大千电台', frequency:'FM99.1', url:'http://125.227.87.206:8000/FM99.1', region:'台湾', category:'新闻'},
    {name:'台湾宝岛联播网寶島新聲', frequency:'FM98.5', url:'http://125.227.87.206:8000/FM98.5', region:'台湾', category:'新闻'},
    {name:'澳广视中文台',     frequency:'网络电台', url:'https://tdm-live.akamaized.net/hls/live/2039480/TDMInfo/master.m3u8', region:'澳门', category:'新闻'},
    {name:'澳广视葡文台',     frequency:'网络电台', url:'https://tdm-live.akamaized.net/hls/live/2039481/TDMVariety/master.m3u8', region:'澳门', category:'音乐'},
    {name:'星河音乐台',       frequency:'网络电台', url:'https://lhttp.qtfm.cn/live/20210755/64k.mp3', region:'海外', category:'音乐'},
    {name:'顺德音乐之声',     frequency:'FM90.1', url:'https://lhttp.qtfm.cn/live/20500150/64k.mp3', region:'海外', category:'音乐'},
    {name:'520电台',         frequency:'网络电台', url:'https://lhttp.qtfm.cn/live/15318191/64k.mp3', region:'海外', category:'音乐'},
    {name:'古典音乐台',       frequency:'网络电台', url:'https://lhttp.qtfm.cn/live/20500181/64k.mp3', region:'海外', category:'音乐'},
    {name:'BBC英语',          frequency:'网络电台', url:'http://stream.live.vc.bbcmedia.co.uk/bbc_world_service', region:'海外', category:'新闻'},
    {name:'中央经济之声',     frequency:'FM96.6', url:'https://ngcdn002.cnr.cn/live/jjzs/index.m3u8', region:'中央', category:'经济'},
    {name:'中央中国之声',     frequency:'FM106.1', url:'https://ngcdn001.cnr.cn/live/zgzs/index.m3u8', region:'中央', category:'新闻'},
    {name:'台海之声',         frequency:'网络电台', url:'https://ngcdn002.cnr.cn/live/zhzs/index.m3u8', region:'中央', category:'新闻'},
    {name:'中央文艺之声',     frequency:'FM106.6', url:'https://ngcdn002.cnr.cn/live/wyzs/index.m3u8', region:'中央', category:'文艺'},
    {name:'音乐之声',         frequency:'FM90.0', url:'https://ngcdn002.cnr.cn/live/yyzs/index.m3u8', region:'中央', category:'音乐'},
    {name:'经典音乐广播',     frequency:'FM101.8', url:'https://ngcdn002.cnr.cn/live/dszs/index.m3u8', region:'中央', category:'音乐'},
    {name:'阅读之声',         frequency:'AM747', url:'https://ngcdn002.cnr.cn/live/ylgb/index.m3u8', region:'中央', category:'教育'},
    {name:'交通之声',         frequency:'FM99.6', url:'https://ngcdn002.cnr.cn/live/gsgljtgb/index.m3u8', region:'中央', category:'交通'},
    {name:'环球资讯广播',     frequency:'FM90.5', url:'https://sk.cri.cn/905.m3u8', region:'中央', category:'新闻'},
    {name:'南海之声',         frequency:'网络电台', url:'https://sk.cri.cn/nhzs.m3u8', region:'中央', category:'新闻'},
    {name:'CGTN',             frequency:'AM846', url:'https://sk.cri.cn/am846.m3u8', region:'中央', category:'新闻'},
    {name:'轻松调频',         frequency:'FM91.5', url:'https://sk.cri.cn/887.m3u8', region:'中央', category:'音乐'},
  ];
  
  function isGarbage(name) {
    if (!name) return true;
    let cnt = 0;
    for (let i = 0; i < name.length; i++) {
      if (badChars.includes(name.charAt(i))) cnt++;
    }
    return cnt > name.length * 0.5;
  }
  
  function isValidUrl(url) {
    try {
      new URL(url);
      return true;
    } catch(e) {
      return false;
    }
  }
  
  const frequencyMap = {
    '北京新闻广播': 'FM94.5',
    '北京交通广播': 'FM103.9',
    '北京音乐广播': 'FM97.4',
    '北京文艺广播': 'FM87.6',
    '上海新闻广播': 'FM93.4',
    '上海流行音乐广播': 'FM101.7',
    '上海经典音乐广播': 'FM94.7',
    '上海经典金曲广播': 'FM103.7',
    '上海戏剧曲艺广播': 'FM97.2',
    '广东新闻广播': 'FM91.4',
    '广东音乐之声': 'FM90.0',
    '广东珠江经济台': 'FM97.4',
    '广东交通之声': 'FM105.2',
    '广东股市广播': 'FM95.3',
    '深圳新闻广播': 'FM89.8',
    '深圳音乐广播': 'FM97.1',
    '广州新闻资讯广播': 'FM96.2',
    '广州金曲音乐广播': 'FM102.7',
    '江苏新闻广播': 'FM93.7',
    '江苏经典流行音乐广播': 'FM97.5',
    '江苏故事广播': 'FM104.9',
    '南京交通广播': 'FM102.4',
    '南京音乐广播': 'FM105.8',
    '山东交通广播': 'FM101.1',
    '济南故事广播': 'FM104.3',
    '四川新闻广播': 'FM98.1',
    '成都简单音乐广播': 'FM105.1',
    '河南戏曲广播': 'FM97.6',
    '湖南音乐之声': 'FM90.1',
    '湖北楚天交通广播': 'FM92.7',
    '安徽小说评书广播': 'FM99.5',
    '福建新闻广播': 'FM96.1',
    '厦门新闻广播': 'FM99.6',
    '辽宁交通广播': 'FM97.5',
    '沈阳新闻广播': 'FM104.5',
    '大连新闻广播': 'FM103.3',
    '河北新闻广播': 'FM104.3',
    '陕西交通广播': 'FM91.6',
    '陕西新闻广播': 'FM106.6',
    '山西音乐广播': 'FM94.0',
    '山西新闻广播': 'FM88.0',
    '江西新闻广播': 'FM104.4',
    '云南新闻广播': 'FM91.8',
    '贵州新闻广播': 'FM94.6',
    '广西新闻广播': 'FM91.0',
    '天津新闻广播': 'FM97.2',
    '天津交通广播': 'FM106.8',
    '重庆交通广播': 'FM95.5',
    '黑龙江新闻广播': 'FM94.6',
    '哈尔滨新闻广播': 'FM106.2',
    '吉林新闻广播': 'FM101.9',
    '长春新闻广播': 'FM88.9',
    '内蒙古新闻广播': 'FM95.0',
    '内蒙古音乐之声': 'FM90.0',
    '内蒙古评书曲艺广播': 'FM102.8',
    '包头交通广播': 'FM89.2',
    '鄂尔多斯汉语综合广播': 'FM97.3',
    '鄂尔多斯交通文体广播': 'FM100.8',
    '新疆新闻广播': 'FM96.1',
    '西藏新闻广播': 'FM93.3',
    '甘肃新闻广播': 'FM96.0',
    '青海新闻广播': 'FM98.9',
    '宁夏新闻广播': 'FM106.1',
    '海南新闻广播': 'FM88.6',
    '香港电台': 'RTHK',
    '杭州交通经济广播': 'FM91.8',
    '杭州西湖之声': 'FM105.4',
    '杭州音乐时尚广播': 'FM96.8',
    '宁波新闻广播': 'FM92.0',
    '温州新闻广播': 'FM94.9',
    '苏州新闻广播': 'FM91.1',
    '无锡新闻广播': 'FM93.7',
    '徐州农村广播': 'FM105.0',
    '青岛新闻广播': 'FM107.6',
    '烟台新闻广播': 'FM101.0',
    '佛山南海广播': 'FM92.4',
    '顺德音乐之声': 'FM90.1',
    '东莞新闻广播': 'FM100.8',
    '怀集音乐之声': 'FM90.0',
    '衡水交通评书广播': 'FM92.5',
    'CRI环球资讯广播': 'FM90.5',
    'CRI劲曲调频': 'FM88.7',
    'CRI轻松调频': 'FM91.5',
    'CNR中国之声': 'FM106.1',
    'CNR经济之声': 'FM96.6',
    'CNR音乐之声': 'FM90.0',
    'CNR经典音乐广播': 'FM101.8',
    'CNR文艺之声': 'FM106.6',
    'CNR老年之声': 'FM104.4',
    'CNR阅读之声': 'AM747',
    'CNR中国交通广播': 'FM99.6',
    '第一财经': 'FM97.7',
  };
  
  function normalizeFrequency(freq, name) {
    if (!freq || freq === '网络电台') {
      if (frequencyMap[name]) {
        return frequencyMap[name];
      }
      const match = name.match(/FM(\d+\.?\d*)/);
      if (match) {
        return 'FM' + match[1];
      }
      const amMatch = name.match(/AM(\d+)/);
      if (amMatch) {
        return 'AM' + amMatch[1];
      }
      return '网络电台';
    }
    freq = freq.trim();
    if (/^FM\d+(\.\d+)?$/.test(freq)) return freq;
    if (/^\d+\.?\d*\s*FM$/.test(freq)) {
      const num = freq.match(/\d+\.?\d*/)[0];
      return 'FM' + num;
    }
    if (/^AM\d+$/.test(freq)) return freq;
    if (/^\d+\s*AM$/.test(freq)) {
      const num = freq.match(/\d+/)[0];
      return 'AM' + num;
    }
    if (/^\d+\.?\d*$/.test(freq)) {
      const num = parseFloat(freq);
      if (!isNaN(num) && num >= 500 && num <= 1700) {
        return 'AM' + freq;
      }
      return 'FM' + freq;
    }
    if (freq.includes('电视')) return '电视伴音';
    return '网络电台';
  }
  
  const regions = [
    {name:'电视伴音',   kw:['电视伴音', 'CCTV', '卫视', 'BTV']},
    {name:'国际',       kw:['国际', 'BBC', 'NPR', 'CRI', 'China Plus', '亚洲', 'Asia']},
    {name:'北京',       kw:['北京', 'BRTV', '房山', '通州', '大兴', '延庆', '密云', '怀柔', '平谷', '门头沟', '石景山', '海淀', '朝阳', '丰台', '顺义', '昌平', '京津冀']},
    {name:'上海',       kw:['上海', '东方', 'SMG', '浦东', '闵行', '杨浦', '徐汇', '长宁', '普陀', '闸北', '虹口', '金山', '松江', '青浦', '奉贤', '崇明', '嘉定']},
    {name:'广东',       kw:['广东', '广州', '珠江', '羊城', '深圳', '佛山', '顺德', '东莞', '怀集', '两广', '粤语', '凤凰卫视', '中山', '珠海', '惠州', '肇庆', '汕头', '湛江', '茂名', '阳江', '清远', '河源', '梅州', '江门', '汕尾', '韶关', '揭阳', '潮州', '云浮', '台山', '开平', '恩平', '斗门', '花都', '增城', '宝安', '英德', '从化', '博罗', '惠东', '普宁', '澄海', '陆丰', '海丰', '阳春', '信宜', '高州', '化州', '廉江', '雷州', '吴川', '鹤山']},
    {name:'浙江',       kw:['浙江', '杭州', '宁波', '温州', '西湖', '嘉兴', '湖州', '绍兴', '金华', '衢州', '舟山', '台州', '丽水', '义乌', '海宁', '东阳', '上虞', '慈溪', '余姚', '温岭', '乐清', '瑞安', '永嘉', '苍南', '平阳', '泰顺', '文成', '武义', '永康', '浦江', '兰溪', '龙游', '江山', '常山', '开化', '玉环', '天台', '仙居', '三门', '临海', '黄岩', '路桥', '椒江', '宁海', '象山', '奉化', '北仑', '镇海', '鄞州', '海曙', '江北', '绍兴县', '柯桥', '诸暨', '嵊州', '新昌', '桐乡', '平湖', '海盐', '嘉善', '德清', '长兴', '安吉', '龙泉', '庆元', '松阳', '云和', '青田', '景宁', '缙云', '遂昌']},
    {name:'江苏',       kw:['江苏', '南京', '苏州', '无锡', '徐州', '金陵', '扬州', '常州', '南通', '连云港', '淮安', '盐城', '镇江', '泰州', '宿迁', '昆山', '张家港', '常熟', '太仓', '吴江', '江阴', '宜兴', '丹阳', '扬中', '句容', '靖江', '泰兴', '如皋', '海门', '启东', '如东', '海安', '东台', '大丰', '射阳', '建湖', '阜宁', '滨海', '响水', '涟水', '金湖', '盱眙', '洪泽', '淮阴', '沭阳', '泗阳', '泗洪', '新沂', '邳州', '赣榆', '东海', '灌云', '灌南', '江宁', '浦口', '六合', '溧水', '高淳', '武进', '金坛', '溧阳', '相城', '吴中', '姑苏', '锡山', '惠山']},
    {name:'山东',       kw:['山东', '济南', '青岛', '烟台', '齐鲁', '淄博', '潍坊', '济宁', '泰安', '威海', '日照', '莱芜', '临沂', '德州', '聊城', '滨州', '菏泽', '枣庄', '东营', '章丘', '即墨', '胶州', '平度', '莱西', '桓台', '高青', '沂源', '寿光', '诸城', '安丘', '高密', '昌邑', '临朐', '青州', '昌乐', '曲阜', '兖州', '邹城', '鱼台', '金乡', '嘉祥', '汶上', '泗水', '梁山', '肥城', '宁阳', '东平', '新泰', '文登', '荣成', '乳山', '莒县', '五莲', '平邑', '费县', '蒙阴', '沂南', '沂水', '兰陵', '郯城', '临沭', '陵县', '宁津', '庆云', '乐陵', '临邑', '平原', '夏津', '武城', '齐河', '禹城', '高唐', '临清', '阳谷', '莘县', '茌平', '东阿', '冠县', '惠民', '阳信', '无棣', '沾化', '博兴', '邹平', '郓城', '鄄城', '曹县', '定陶', '成武', '单县', '巨野', '东明', '滕州', '薛城', '峄城', '台儿庄', '山亭', '河口', '垦利', '利津', '广饶']},
    {name:'四川',       kw:['四川', '成都', '天府', '岷江', '绵阳', '德阳', '南充', '达州', '遂宁', '内江', '乐山', '自贡', '泸州', '宜宾', '广安', '广元', '眉山', '资阳', '巴中', '雅安', '攀枝花', '凉山', '甘孜', '阿坝', '新都', '郫都', '双流', '温江', '龙泉', '新津', '崇州', '彭州', '都江堰', '邛崃', '大邑', '蒲江', '青白江', '金堂', '什邡', '绵竹', '广汉', '江油', '三台', '射洪', '中江', '南部', '阆中', '西充', '仪陇', '营山', '蓬安', '富顺', '荣县', '泸县', '合江', '叙永', '古蔺', '江安', '长宁', '高县', '珙县', '筠连', '兴文', '屏山', '华蓥', '岳池', '武胜', '邻水', '苍溪', '旺苍', '剑阁', '青川', '仁寿', '洪雅', '丹棱', '彭山', '安岳', '乐至', '平昌', '通江', '南江', '名山', '荥经', '汉源', '石棉', '天全', '芦山', '宝兴', '米易', '盐边', '西昌']},
    {name:'河南',       kw:['河南', '郑州', '中原', '开封', '洛阳', '平顶山', '安阳', '鹤壁', '新乡', '焦作', '濮阳', '许昌', '漯河', '三门峡', '南阳', '商丘', '信阳', '周口', '驻马店', '巩义', '荥阳', '新密', '新郑', '登封', '中牟', '兰考', '杞县', '通许', '尉氏', '偃师', '孟津', '新安', '栾川', '嵩县', '汝阳', '宜阳', '洛宁', '伊川', '汝州', '宝丰', '叶县', '鲁山', '郏县', '林州', '汤阴', '滑县', '内黄', '浚县', '淇县', '卫辉', '辉县', '获嘉', '原阳', '延津', '封丘', '长垣', '沁阳', '孟州', '修武', '博爱', '武陟', '温县', '济源', '清丰', '南乐', '范县', '台前', '禹州', '长葛', '鄢陵', '襄城', '舞阳', '临颍', '义马', '灵宝', '渑池', '陕县', '卢氏', '邓州', '方城', '社旗', '西峡', '淅川', '新野', '唐河', '桐柏', '民权', '睢县', '宁陵', '柘城', '虞城', '夏邑', '永城', '固始', '淮滨', '息县', '新县', '商城', '潢川', '光山', '罗山', '扶沟', '西华', '商水', '太康', '鹿邑', '郸城', '沈丘', '项城', '淮阳', '确山', '泌阳', '遂平', '西平', '上蔡', '汝南', '平舆', '正阳', '新蔡']},
    {name:'湖南',       kw:['湖南', '长沙', '潇湘', '衡阳', '株洲', '湘潭', '邵阳', '岳阳', '常德', '张家界', '益阳', '郴州', '永州', '怀化', '娄底', '湘西', '浏阳', '宁乡', '望城', '醴陵', '攸县', '茶陵', '炎陵', '湘潭县', '湘乡', '韶山', '邵东', '新邵', '隆回', '洞口', '绥宁', '城步', '武冈', '新宁', '华容', '湘阴', '平江', '汨罗', '临湘', '安乡', '汉寿', '澧县', '临澧', '桃源', '石门', '津市', '慈利', '桑植', '南县', '桃江', '安化', '沅江', '桂阳', '宜章', '永兴', '嘉禾', '临武', '汝城', '桂东', '安仁', '资兴', '祁阳', '东安', '双牌', '道县', '江永', '宁远', '蓝山', '新田', '江华', '沅陵', '辰溪', '溆浦', '中方', '洪江', '会同', '麻阳', '新晃', '芷江', '靖州', '通道', '双峰', '新化', '冷水江', '涟源']},
    {name:'湖北',       kw:['湖北', '武汉', '楚天', '宜昌', '襄阳', '黄石', '十堰', '荆州', '荆门', '鄂州', '孝感', '黄冈', '咸宁', '随州', '恩施', '黄陂', '新洲', '江夏', '蔡甸', '汉南', '东西湖', '江岸', '江汉', '硚口', '汉阳', '武昌', '青山', '洪山', '宜都', '枝江', '当阳', '远安', '兴山', '秭归', '长阳', '五峰', '老河口', '谷城', '南漳', '枣阳', '宜城', '保康', '大冶', '阳新', '丹江口', '郧县', '郧西', '竹山', '竹溪', '房县', '松滋', '石首', '公安', '监利', '洪湖', '钟祥', '京山', '沙洋', '应城', '安陆', '汉川', '云梦', '大悟', '孝昌', '麻城', '武穴', '团风', '红安', '罗田', '英山', '浠水', '蕲春', '黄梅', '赤壁', '嘉鱼', '通城', '崇阳', '通山', '广水', '利川', '建始', '巴东', '宣恩', '咸丰', '来凤', '鹤峰']},
    {name:'安徽',       kw:['安徽', '合肥', '江淮', '芜湖', '蚌埠', '淮南', '马鞍山', '淮北', '铜陵', '安庆', '黄山', '滁州', '阜阳', '宿州', '六安', '亳州', '池州', '宣城', '肥东', '肥西', '长丰', '庐江', '巢湖', '繁昌', '南陵', '无为', '怀远', '五河', '固镇', '凤台', '寿县', '当涂', '含山', '和县', '濉溪', '铜陵县', '桐城', '怀宁', '枞阳', '潜山', '太湖', '宿松', '望江', '岳西', '歙县', '休宁', '黟县', '祁门', '天长', '明光', '来安', '全椒', '定远', '凤阳', '界首', '临泉', '太和', '阜南', '颍上', '砀山', '萧县', '灵璧', '泗县', '霍邱', '舒城', '金寨', '霍山', '涡阳', '蒙城', '利辛', '贵池', '东至', '石台', '青阳', '宁国', '郎溪', '广德', '泾县', '绩溪', '旌德']},
    {name:'福建',       kw:['福建', '福州', '厦门', '闽南', '泉州', '漳州', '莆田', '三明', '南平', '龙岩', '宁德', '晋江', '石狮', '南安', '安溪', '永春', '德化', '惠安', '龙海', '漳浦', '云霄', '诏安', '东山', '平和', '南靖', '华安', '长泰', '仙游', '永安', '明溪', '清流', '宁化', '大田', '尤溪', '沙县', '将乐', '泰宁', '建宁', '邵武', '武夷山', '建瓯', '建阳', '顺昌', '浦城', '光泽', '松溪', '政和', '漳平', '长汀', '永定', '上杭', '武平', '连城', '福安', '福鼎', '霞浦', '古田', '屏南', '寿宁', '周宁', '柘荣']},
    {name:'辽宁',       kw:['辽宁', '沈阳', '大连', '东北', '鞍山', '抚顺', '本溪', '丹东', '锦州', '营口', '阜新', '辽阳', '铁岭', '朝阳', '盘锦', '瓦房店', '普兰店', '庄河', '海城', '抚顺县', '新宾', '清原', '本溪', '桓仁', '东港', '凤城', '凌海', '北镇', '盖州', '大石桥', '彰武', '阜新县', '灯塔', '辽阳县', '开原', '调兵山', '铁岭', '西丰', '朝阳', '北票', '凌源', '建平', '喀左', '盘山', '大洼', '兴城', '绥中', '建昌']},
    {name:'河北',       kw:['河北', '石家庄', '衡水', '燕赵', '唐山', '秦皇岛', '邯郸', '邢台', '保定', '张家口', '承德', '沧州', '廊坊', '涿州', '定州', '辛集', '霸州', '遵化', '迁安', '滦州', '滦南', '乐亭', '迁西', '玉田', '曹妃甸', '丰润', '丰南', '山海关', '北戴河', '昌黎', '抚宁', '卢龙', '武安', '峰峰', '临漳', '成安', '大名', '涉县', '磁县', '肥乡', '永年', '邱县', '鸡泽', '广平', '馆陶', '魏县', '曲周', '沙河', '南宫', '巨鹿', '新河', '广宗', '平乡', '威县', '清河', '临西', '内丘', '柏乡', '隆尧', '任县', '南和', '宁晋', '安国', '高碑店', '涞水', '阜平', '定兴', '唐县', '高阳', '容城', '涞源', '望都', '安新', '易县', '曲阳', '蠡县', '顺平', '博野', '雄县', '宣化', '康保', '张北', '阳原', '赤城', '沽源', '怀安', '怀来', '崇礼', '尚义', '蔚县', '涿鹿', '万全', '平泉', '承德县', '兴隆', '滦平', '隆化', '丰宁', '宽城', '围场', '泊头', '任丘', '黄骅', '河间', '沧县', '青县', '东光', '海兴', '盐山', '肃宁', '南皮', '吴桥', '献县', '孟村', '三河', '固安', '永清', '香河', '大城', '文安', '大厂']},
    {name:'陕西',       kw:['陕西', '西安', '大秦', '咸阳', '宝鸡', '渭南', '铜川', '延安', '榆林', '汉中', '安康', '商洛', '临潼', '长安', '高陵', '户县', '周至', '蓝田', '兴平', '三原', '泾阳', '乾县', '礼泉', '永寿', '彬县', '长武', '旬邑', '淳化', '武功', '凤翔', '岐山', '扶风', '眉县', '陇县', '千阳', '麟游', '凤县', '太白', '华阴', '潼关', '大荔', '合阳', '澄城', '蒲城', '白水', '富平', '韩城', '耀州', '宜君', '延长', '延川', '子长', '安塞', '志丹', '吴起', '甘泉', '富县', '洛川', '宜川', '黄龙', '黄陵', '神木', '府谷', '横山', '靖边', '定边', '绥德', '米脂', '佳县', '吴堡', '清涧', '子洲', '南郑', '城固', '洋县', '西乡', '勉县', '宁强', '略阳', '镇巴', '留坝', '佛坪', '汉阴', '石泉', '宁陕', '紫阳', '岚皋', '平利', '镇坪', '旬阳', '白河', '洛南', '丹凤', '商南', '山阳', '镇安', '柞水']},
    {name:'山西',       kw:['山西', '太原', '三晋', '大同', '阳泉', '长治', '晋城', '朔州', '晋中', '运城', '忻州', '临汾', '吕梁', '晋东南', '古交', '清徐', '阳曲', '娄烦', '矿区', '南郊', '新荣', '阳高', '天镇', '广灵', '灵丘', '浑源', '左云', '郊区', '平定', '盂县', '潞城', '长治县', '襄垣', '屯留', '平顺', '黎城', '壶关', '长子', '武乡', '沁县', '沁源', '高平', '阳城', '陵川', '泽州', '平鲁', '山阴', '应县', '右玉', '怀仁', '介休', '榆次', '太谷', '祁县', '平遥', '灵石', '寿阳', '昔阳', '和顺', '左权', '榆社', '永济', '河津', '芮城', '临猗', '万荣', '新绛', '稷山', '闻喜', '夏县', '绛县', '平陆', '垣曲', '原平', '定襄', '五台', '代县', '繁峙', '宁武', '静乐', '神池', '五寨', '岢岚', '河曲', '保德', '偏关', '侯马', '霍州', '曲沃', '翼城', '襄汾', '洪洞', '古县', '安泽', '浮山', '吉县', '乡宁', '蒲县', '大宁', '永和', '隰县', '汾西', '孝义', '汾阳', '文水', '交城', '兴县', '临县', '柳林', '石楼', '岚县', '方山', '中阳', '交口']},
    {name:'江西',       kw:['江西', '南昌', '赣', '九江', '景德镇', '萍乡', '新余', '鹰潭', '赣州', '吉安', '宜春', '抚州', '上饶', '赣北', '新建', '南昌县', '进贤', '安义', '瑞昌', '共青城', '九江', '星子', '武宁', '修水', '永修', '德安', '都昌', '湖口', '彭泽', '乐平', '浮梁', '湘东', '上栗', '莲花', '分宜', '贵溪', '余江', '瑞金', '南康', '赣县', '信丰', '大余', '上犹', '崇义', '安远', '龙南', '定南', '全南', '宁都', '于都', '兴国', '会昌', '寻乌', '石城', '井冈山', '吉安县', '吉水', '峡江', '新干', '永丰', '泰和', '遂川', '万安', '安福', '永新', '丰城', '樟树', '高安', '奉新', '万载', '上高', '宜丰', '靖安', '铜鼓', '临川', '南城', '黎川', '南丰', '崇仁', '乐安', '宜黄', '金溪', '资溪', '东乡', '德兴', '上饶', '广丰', '玉山', '铅山', '横峰', '弋阳', '余干', '鄱阳', '万年', '婺源']},
    {name:'云南',       kw:['云南', '昆明', '七彩', '大理', '丽江', '曲靖', '玉溪', '保山', '昭通', '普洱', '临沧', '楚雄', '红河', '文山', '西双版纳', '德宏', '怒江', '迪庆', '安宁', '富民', '嵩明', '宜良', '石林', '寻甸', '禄劝', '宣威', '马龙', '沾益', '富源', '罗平', '师宗', '陆良', '会泽', '江川', '澄江', '通海', '华宁', '易门', '峨山', '新平', '元江', '腾冲', '施甸', '龙陵', '昌宁', '鲁甸', '巧家', '盐津', '大关', '永善', '绥江', '镇雄', '彝良', '威信', '水富', '宁洱', '墨江', '景东', '景谷', '镇沅', '江城', '孟连', '澜沧', '西盟', '凤庆', '云县', '永德', '镇康', '双江', '耿马', '沧源', '禄丰', '牟定', '南华', '姚安', '大姚', '永仁', '元谋', '武定', '双柏', '个旧', '开远', '蒙自', '屏边', '建水', '石屏', '弥勒', '泸西', '元阳', '红河县', '金平', '绿春', '河口', '砚山', '西畴', '麻栗坡', '马关', '丘北', '广南', '富宁', '景洪', '勐海', '勐腊', '芒市', '瑞丽', '梁河', '盈江', '陇川', '泸水', '福贡', '贡山', '兰坪', '香格里拉', '德钦', '维西']},
    {name:'贵州',       kw:['贵州', '贵阳', '遵义', '六盘水', '安顺', '毕节', '铜仁', '黔东南', '黔南', '黔西南', '清镇', '开阳', '息烽', '修文', '赤水', '仁怀', '遵义', '桐梓', '绥阳', '正安', '道真', '务川', '凤冈', '湄潭', '余庆', '习水', '盘州', '水城', '平坝', '普定', '镇宁', '关岭', '紫云', '黔西', '大方', '金沙', '织金', '纳雍', '威宁', '赫章', '江口', '玉屏', '石阡', '思南', '印江', '德江', '沿河', '松桃', '万山', '凯里', '黄平', '施秉', '三穗', '镇远', '岑巩', '天柱', '锦屏', '剑河', '台江', '黎平', '榕江', '从江', '雷山', '麻江', '丹寨', '都匀', '福泉', '荔波', '贵定', '瓮安', '独山县', '平塘', '罗甸', '长顺', '龙里', '惠水', '三都', '兴义', '兴仁', '普安', '晴隆', '贞丰', '望谟', '册亨', '安龙']},
    {name:'广西',       kw:['广西', '南宁', '北部湾', '柳州', '桂林', '梧州', '北海', '防城港', '钦州', '贵港', '玉林', '百色', '贺州', '河池', '来宾', '崇左', '邕宁', '武鸣', '隆安', '马山', '上林', '宾阳', '横县', '柳城', '柳江', '鹿寨', '融安', '融水', '三江', '阳朔', '临桂', '灵川', '全州', '兴安', '永福', '灌阳', '资源', '平乐', '荔浦', '恭城', '苍梧', '藤县', '蒙山', '岑溪', '合浦', '上思', '东兴', '灵山', '浦北', '桂平', '平南', '容县', '陆川', '博白', '北流', '田阳', '田东', '平果', '德保', '靖西', '那坡', '凌云', '乐业', '田林', '西林', '隆林', '昭平', '钟山', '富川', '南丹', '天峨', '凤山县', '东兰', '罗城', '环江', '巴马', '都安', '大化', '忻城', '象州', '武宣', '金秀', '扶绥', '宁明', '龙州', '大新', '天等', '凭祥']},
    {name:'天津',       kw:['天津', '海河', '滨海', '武清', '宝坻', '蓟县', '宁河', '静海', '津南', '西青', '北辰', '东丽', '塘沽', '汉沽', '大港']},
    {name:'重庆',       kw:['重庆', '嘉陵', '万州', '涪陵', '黔江', '永川', '江津', '合川', '南川', '綦江', '大足', '璧山', '铜梁', '潼南', '荣昌', '开州', '梁平', '武隆', '城口', '丰都', '垫江', '忠县', '云阳', '奉节', '巫山', '巫溪', '石柱', '秀山', '酉阳', '彭水', '渝北', '江北', '南岸', '九龙坡', '沙坪坝', '大渡口', '北碚', '巴南', '长寿']},
    {name:'黑龙江',     kw:['黑龙江', '哈尔滨', '北国', '齐齐哈尔', '牡丹江', '佳木斯', '大庆', '鸡西', '双鸭山', '伊春', '七台河', '鹤岗', '黑河', '绥化', '大兴安岭', '呼兰', '阿城', '双城', '五常', '尚志', '宾县', '巴彦', '木兰', '通河', '方正', '依兰', '讷河', '龙江', '依安', '泰来', '甘南', '富裕', '克山', '克东', '拜泉', '穆棱', '绥芬河', '东宁', '林口', '海林', '宁安', '同江', '富锦', '桦南', '桦川', '汤原', '抚远', '肇州', '肇源', '林甸', '杜尔伯特', '虎林', '密山', '鸡东', '集贤', '友谊', '宝清', '饶河', '铁力', '嘉荫', '勃利', '萝北', '绥滨', '北安', '五大连池', '嫩江', '逊克', '孙吴', '安达', '肇东', '海伦', '望奎', '兰西', '青冈', '庆安', '明水', '绥棱', '呼玛', '塔河', '漠河']},
    {name:'吉林',       kw:['吉林', '长春', '四平', '辽源', '通化', '白山', '松原', '白城', '延边', '九台', '榆树', '德惠', '农安', '公主岭', '双辽', '梨树', '伊通', '东丰', '东辽', '梅河口', '集安', '通化', '辉南', '柳河', '临江', '抚松', '靖宇', '长白', '扶余', '前郭', '长岭', '乾安', '洮南', '大安', '镇赉', '通榆', '延吉', '图们', '敦化', '珲春', '龙井', '和龙', '汪清', '安图']},
    {name:'内蒙古',     kw:['内蒙古', '包头', '鄂尔多斯', '草原', '呼和浩特', '赤峰', '通辽', '呼伦贝尔', '巴彦淖尔', '乌兰察布', '兴安', '锡林郭勒', '阿拉善', '土左旗', '土右旗', '托克托', '和林格尔', '清水河', '武川', '东河', '昆都仑', '青山', '石拐', '白云鄂博', '九原', '固阳', '达尔罕茂明安', '东胜', '达拉特', '准格尔', '鄂托克前旗', '鄂托克', '杭锦', '乌审', '伊金霍洛', '红山', '元宝山', '松山', '阿鲁科尔沁', '巴林左旗', '巴林右旗', '林西', '克什克腾', '翁牛特', '喀喇沁', '宁城', '敖汉', '科尔沁', '霍林郭勒', '科尔沁左翼中旗', '科尔沁左翼后旗', '开鲁', '库伦', '奈曼', '扎鲁特', '海拉尔', '满洲里', '扎兰屯', '牙克石', '根河', '额尔古纳', '陈巴尔虎', '鄂温克', '新巴尔虎左旗', '新巴尔虎右旗', '莫力达瓦', '阿荣', '鄂伦春', '临河', '五原', '磴口', '乌拉特前旗', '乌拉特中旗', '乌拉特后旗', '杭锦后旗', '集宁', '丰镇', '卓资', '化德', '商都', '兴和', '凉城', '察哈尔右翼前旗', '察哈尔右翼中旗', '察哈尔右翼后旗', '四子王', '乌兰浩特', '阿尔山', '科尔沁右翼前旗', '科尔沁右翼中旗', '扎赉特', '突泉', '二连浩特', '锡林浩特', '阿巴嘎', '苏尼特左旗', '苏尼特右旗', '东乌珠穆沁', '西乌珠穆沁', '太仆寺', '镶黄旗', '正镶白旗', '正蓝旗', '多伦', '阿拉善左旗', '阿拉善右旗', '额济纳']},
    {name:'新疆',       kw:['新疆', '乌鲁木齐', '克拉玛依', '吐鲁番', '哈密', '阿克苏', '喀什', '和田', '伊犁', '塔城', '阿勒泰', '昌吉', '博尔塔拉', '巴音郭楞', '克孜勒苏', '石河子', '阿拉尔', '图木舒克', '五家渠', '乌鲁木齐县', '达坂城', '米东', '独山子', '白碱滩', '乌尔禾', '鄯善', '托克逊', '巴里坤', '伊吾', '温宿', '库车', '沙雅', '新和', '拜城', '乌什', '阿瓦提', '柯坪', '疏附', '疏勒', '英吉沙', '泽普', '莎车', '叶城', '麦盖提', '岳普湖', '伽师', '巴楚', '塔什库尔干', '和田', '墨玉', '皮山', '洛浦', '策勒', '于田', '民丰', '伊宁', '奎屯', '霍尔果斯', '尼勒克', '伊宁县', '察布查尔', '霍城', '巩留', '新源', '昭苏', '特克斯', '塔城', '额敏', '沙湾', '托里', '裕民', '和布克赛尔', '阿勒泰', '布尔津', '富蕴', '福海', '哈巴河', '青河', '吉木乃', '昌吉', '阜康', '米泉', '呼图壁', '玛纳斯', '奇台', '吉木萨尔', '木垒', '博乐', '精河', '温泉', '库尔勒', '轮台', '尉犁', '若羌', '且末', '焉耆', '和静', '和硕', '博湖', '阿图什', '阿克陶', '阿合奇', '乌恰']},
    {name:'西藏',       kw:['西藏', '拉萨', '日喀则', '昌都', '林芝', '山南', '那曲', '阿里', '当雄', '堆龙德庆', '曲水', '墨竹工卡', '达孜', '尼木', '林周', '南木林', '江孜', '定日', '萨迦', '拉孜', '昂仁', '谢通门', '白朗', '仁布', '康马', '定结', '仲巴', '亚东', '吉隆', '聂拉木', '萨嘎', '岗巴', '江达', '贡觉', '类乌齐', '丁青', '察雅', '八宿', '左贡', '芒康', '洛隆', '边坝', '工布江达', '米林', '墨脱', '波密', '察隅', '朗县', '乃东', '扎囊', '贡嘎', '桑日', '琼结', '曲松', '措美', '洛扎', '加查', '隆子', '错那', '浪卡子', '那曲', '嘉黎', '比如', '聂荣', '安多', '申扎', '索县', '班戈', '巴青', '尼玛', '双湖', '普兰', '札达', '噶尔', '日土', '革吉', '改则', '措勤']},
    {name:'甘肃',       kw:['甘肃', '兰州', '嘉峪关', '金昌', '白银', '天水', '酒泉', '张掖', '武威', '定西', '陇南', '平凉', '庆阳', '临夏', '甘南', '永登', '皋兰', '榆中', '永昌', '靖远', '会宁', '景泰', '清水', '秦安', '甘谷', '武山', '张家川', '玉门', '敦煌', '金塔', '瓜州', '肃北', '阿克塞', '肃南', '民乐', '临泽', '高台', '山丹', '民勤', '古浪', '天祝', '通渭', '陇西', '渭源', '临洮', '漳县', '岷县', '成县', '文县', '宕昌', '康县', '西和', '礼县', '徽县', '两当', '泾川', '灵台', '崇信', '华亭', '庄浪', '静宁', '西峰', '庆城', '环县', '华池', '合水', '正宁', '宁县', '镇原', '临夏', '康乐', '永靖', '广河', '和政', '东乡', '积石山', '合作', '临潭', '卓尼', '舟曲', '迭部', '玛曲', '碌曲', '夏河']},
    {name:'青海',       kw:['青海', '西宁', '海东', '海北', '黄南', '海南', '果洛', '玉树', '海西', '大通', '湟中', '湟源', '平安', '乐都', '民和', '互助', '化隆', '循化', '门源', '祁连', '海晏', '刚察', '同仁', '尖扎', '泽库', '河南', '共和', '同德', '贵德', '兴海', '贵南', '玛沁', '班玛', '甘德', '达日', '久治', '玛多', '玉树', '杂多', '称多', '治多', '囊谦', '曲麻莱', '格尔木', '德令哈', '乌兰', '都兰', '天峻']},
    {name:'宁夏',       kw:['宁夏', '银川', '石嘴山', '吴忠', '固原', '中卫', '永宁', '贺兰', '大武口', '惠农', '平罗', '利通', '青铜峡', '盐池', '同心', '原州', '西吉', '隆德', '泾源', '彭阳', '沙坡头', '中宁', '海原']},
    {name:'海南',       kw:['海南', '海口', '三亚', '文昌', '琼海', '万宁', '儋州', '五指山', '东方', '定安', '屯昌', '澄迈', '临高', '白沙', '昌江', '乐东', '陵水', '保亭', '琼中']},
    {name:'香港',       kw:['香港', 'RTHK', '凤凰', '衛視', '衛視台', 'TVB', 'TVBS']},
    {name:'澳门',       kw:['澳门', '澳广视', 'TDM']},
    {name:'台湾',       kw:['台湾', '台北', '台中', '台南', '高雄', '桃园', '新竹', '彰化', '屏东', '花莲', '台东', '澎湖', '宜兰', '苗栗', '南投', '云林', '嘉义', '基隆', '金门', '马祖', '中广', '飞碟', 'HitFM', '亚洲电台', '正声', '警察广播', '复兴电台', '光华之声']},
    {name:'海外',       kw:['新加坡', '日本', 'NHK', 'CNBC', 'FOX', 'ESPN', '東森', '澳洲', '新西兰', '欧洲']},
    {name:'全国',       kw:['全国', '新闻联播']},
    {name:'中央',       kw:['中央', '中国之声', '经济之声', 'CNR', '中央人民广播', '台海之声', '文艺之声', '音乐之声', '经典音乐', '阅读之声', '交通之声', '环球资讯', '南海之声', 'CGTN', '轻松调频', '劲曲调频', '老年之声', '民族之声']},
  ];
  
  const categories = [
    {name:'新闻',       kw:['新闻', '资讯']},
    {name:'音乐',       kw:['音乐', 'Music', '金曲', '歌', 'FM']},
    {name:'经济',       kw:['经济', '财经', '股市', '第一财经']},
    {name:'交通',       kw:['交通']},
    {name:'文艺',       kw:['文艺', '戏曲', '曲艺', '相声', '评书', '小说']},
    {name:'体育',       kw:['体育', 'Sports', '体坛']},
    {name:'生活',       kw:['生活', '都市', '城市']},
    {name:'影视',       kw:['影视', '电影', '电视剧', 'CCTV', '卫视']},
    {name:'教育',       kw:['教育', '教学', '外语', '英语', '课程']},
    {name:'农村',       kw:['农村', '农业', '乡村']},
    {name:'综合',       kw:['综合']},
  ];
  
  function detectRegion(name) {
    let foundRegion = null;
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      if (region.name === '中央') continue;
      for (let j = 0; j < region.kw.length; j++) {
        if (name.includes(region.kw[j])) {
          return region.name;
        }
      }
    }
    for (let j = 0; j < regions.length; j++) {
      const region = regions[j];
      if (region.name === '中央') {
        for (let k = 0; k < region.kw.length; k++) {
          if (name.includes(region.kw[k])) {
            return region.name;
          }
        }
      }
    }
    return '全国';
  }
  
  function detectCategory(name, desc) {
    const text = (name + ' ' + (desc || '')).toLowerCase();
    for (let i = 0; i < categories.length; i++) {
      for (let j = 0; j < categories[i].kw.length; j++) {
        if (text.includes(categories[i].kw[j].toLowerCase())) {
          return categories[i].name;
        }
      }
    }
    return '综合';
  }
  
  function isRegionValid(region) {
    const normalizedRegion = region.trim().replace(/[\uFEFF]/g, '').replace(/\s+/g, '').replace(/[\uFF01-\uFF5E]/g, function(c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    return regions.some(r => r.name === normalizedRegion);
  }
  
  function isCategoryValid(category) {
    return categories.some(c => c.name === category);
  }
  
  const radio = [];
  
  for (let i = 0; i < data.radio.length; i++) {
    const ch = data.radio[i];
    const name = (ch.name || '').trim();
    const url = (ch.url || '').trim();
    
    if (isGarbage(name)) continue;
    if (!url || !isValidUrl(url)) continue;
    
    const detectedRegion = detectRegion(name);
    let region = detectedRegion;
    if (region === '全国' && ch.description) {
      const normalizedDesc = ch.description.trim().replace(/[\uFEFF]/g, '').replace(/\s+/g, '').replace(/[\uFF01-\uFF5E]/g, function(c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
      for (let i = 0; i < regions.length; i++) {
        if (regions[i].name === normalizedDesc || regions[i].kw.some(kw => normalizedDesc.includes(kw))) {
          region = regions[i].name;
          break;
        }
      }
    }
    if (region !== '全国') {
      let found = false;
      for (let i = 0; i < regions.length; i++) {
        if (regions[i].name === region) {
          region = regions[i].name;
          found = true;
          break;
        }
      }
      if (!found) {
        region = '全国';
      }
    }
    const category = ch.category && isCategoryValid(ch.category) ? ch.category : detectCategory(name, ch.description);
    const frequency = normalizeFrequency(ch.frequency, name);
    
    radio.push({
      id: ch.id,
      name: name,
      frequency: frequency,
      url: url,
      color: ch.color || '#d4af37',
      description: region,
      category: category
    });
  }
  
  for (let i = 0; i < backupStations.length; i++) {
    const station = backupStations[i];
    let found = false;
    for (let j = 0; j < radio.length; j++) {
      const r = radio[j];
      if (r.name === station.name) {
        found = true;
        break;
      }
      const rCore = r.name.replace(/^CNR-\d+\s*/, '').replace(/^中央/, '').trim();
      const sCore = station.name.replace(/^CNR-\d+\s*/, '').replace(/^中央/, '').trim();
      if (rCore === sCore || r.name.includes(sCore) || sCore.includes(rCore)) {
        const isBetterUrl = station.url.includes('qingting') || station.url.includes('xmcdn') || station.url.includes('qtfm');
        if (isBetterUrl) {
          radio[j] = {
            id: 'bk' + (i + 1),
            name: station.name,
            frequency: station.frequency,
            url: station.url,
            color: '#4a90e2',
            description: station.region,
            category: station.category
          };
          found = true;
          break;
        }
      }
    }
    if (!found) {
      radio.push({
        id: 'bk' + (i + 1),
        name: station.name,
        frequency: station.frequency,
        url: station.url,
        color: '#4a90e2',
        description: station.region,
        category: station.category
      });
    }
  }
  
  // V70: 100%还原Electron版去重逻辑（name集合/顺序/总数=1652完全不变，URL后处理）
  const urlSeen = new Set();
  const nameSeen = new Set();
  const uniqueRadio = [];
  let urlDuplicates = 0;
  let nameDuplicates = 0;
  for (let i = 0; i < radio.length; i++) {
    const r = radio[i];
    if (urlSeen.has(r.url)) { urlDuplicates++; continue; }
    urlSeen.add(r.url);
    const isThirdParty = r.url.includes('qingting') || r.url.includes('xmcdn') || r.url.includes('qtfm') || r.url.includes('ximalaya');
    if (nameSeen.has(r.name) && isThirdParty) { nameDuplicates++; continue; }
    nameSeen.add(r.name);
    uniqueRadio.push(r);
  }
  console.log('去重统计 - 原始数量:', radio.length, ', 去重后:', uniqueRadio.length, ', URL重复:', urlDuplicates, ', 名称重复(第三方):', nameDuplicates);
  // V70: ONLY URL rewriting. 不增不减任何台，不改顺序。只把死链URL换成可播放URL
  const ngcdnOverride = {};
  backupStations.forEach(function(bk) {
    if (bk.url && (bk.url.includes('ngcdn002.cnr.cn') || bk.url.includes('ngcdn001.cnr.cn'))) {
      ngcdnOverride[bk.name] = bk.url;
      const core = bk.name.replace(/^CNR-\d+\s*/, '').replace(/^中央/, '').trim();
      if (core) ngcdnOverride[core] = bk.url;
    }
  });
  for (let i = 0; i < uniqueRadio.length; i++) {
    const r = uniqueRadio[i];
    if (r.url.startsWith('http://ngcdn002.cnr.cn') || r.url.startsWith('http://ngcdn001.cnr.cn')) {
      r.url = r.url.replace('http://', 'https://');
    }
    if (r.url.includes('satellitepull.cnr.cn') && r.url.includes('wsSession=')) {
      const core1 = r.name.replace(/^CNR-\d+\s*/, '').replace(/^中央/, '').trim();
      let replaced = false;
      if (ngcdnOverride[r.name]) { r.url = ngcdnOverride[r.name]; replaced = true; }
      else if (ngcdnOverride[core1]) { r.url = ngcdnOverride[core1]; replaced = true; }
      if (!replaced) {
        // V104 CRITICAL FIX: satellitepull wsSession=XXXXX 参数=短期CDN签名，160秒左右必过期导致精确断流！
        //  如果backupStations没有对应的ngcdn官方源兜底，就把URL里的wsSession/wsIPSercert参数全部strip掉！
        //  satellitepull.cnr.cn/live/xxx/playlist.m3u8 裸链是不需要鉴权的，只有带wsSession参数才会校验过期时间！
        try {
          const qIdx = r.url.indexOf('?');
          if (qIdx > 0) r.url = r.url.substring(0, qIdx); // 直接剥离所有query参数=永固裸链
        } catch (e) { console.warn('[V104-FIX] strip wsSession FAIL:', r.url.substring(0,40), e&&e.message); }
      }
    }
  }
  // ============================================================
  //  V105-MERGE-SWITCH 电台合并功能总开关（默认false=不合并=您现在5分钟稳定的状态！）
  //  用户刚才实测数据：
  //    ① V102d 不合并=1652台，WebEngine+hls.js+CORShijack+ngcdn永固源 → 息屏5分钟+稳定✅
  //    ② 合并功能不完整（缺V1.3.89名称归一化："中央文艺之声"="文艺之声"="CNR-9 文艺之声"没合并）→ 当前合并=1623台，合并不彻底
  //    ③ 之前V88合并版无声=不是合并功能本身，是"排序错误→satellitepull.wsSession过期源排线路1默认播放"
  //  所以：默认ENABLE_MERGE=false=完全回到现在5分钟稳定的不合并状态！
  //  想启用合并版功能的话：把ENABLE_MERGE改成true（将启用：精确name合并+未来V1.3.89名称归一化+CDN priority排序+多线路urls数组）
  // ============================================================
  const ENABLE_MERGE = false; // ⭐ DEFAULT FALSE = 不合并！5分钟稳定版！
  // ⭐ 永久生效防御（无论ENABLE_MERGE真假）：uniqueRadio里每台的URL都经过上面的wsSession strip，防过期签名！
  // ============================================================
  //  V104-FINAL 恢复电台合并功能 (V1.3.88核心 完全恢复)
  //  修复1: 按name归一化 → 合并多个重复名称电台为1个 → urls[]=多线路
  //  修复2(最关键): 同电台内多条线路 按【CDN稳定度优先级】严格排序，稳定的放前=默认线路！
  //     P0: ngcdn001/002.cnr.cn 中央台官方CDN(无鉴权参数，永久有效！)=必须排线路1！
  //     P1: qtfm.cn/qingting.fm/xmcdn 蜻蜓/喜马拉雅(稳定MP3流)=线路2/3
  //     P2: alicdn.com/myalicdn.com 阿里云CDN=线路3/4
  //     P3: 省级/地方台CDN(zbbf2.*等)=线路4/5
  //     P9(最末): satellitepull.cnr.cn + wsSession(即使strip了参数，也尽量排最后！裸链效果不如ngcdn官方)=仅手动兜底
  //  修复3(先不启用自动切线路): LineMonitor后台定时器在息屏时JS冻结=异常。暂时不启动它，只保留UI手动"线路N"按钮切换
  // ============================================================
  function cdnPriorityOf(url) {
    // 数值越大=越稳定=排越前 (最后urls.sort的reverse顺序)
    if (!url) return -999;
    if (/ngcdn00[12]\.cnr\.cn/i.test(url))                          return 900; // P0 中央台官方CDN 永固
    if (/ngcdn\.cnr\.cn|cnr\.cn\/live/i.test(url))                  return 850; // P0b 中央台其他官方
    if (/lhttp\.qtfm\.cn|qingting\.fm|qtfm\.cn/i.test(url))         return 700; // P1 蜻蜓 稳定MP3
    if (/xmcdn\.com|ximalaya\.com|fms\.od\.xiaomi/i.test(url))      return 650; // P1b 喜马拉雅/小米
    if (/alicdn\.com|myalicdn\.com/i.test(url))                     return 500; // P2 阿里云CDN
    if (/\.douyincdn\.com|douyin\.com|huoshan\.com/i.test(url))     return 450; // P2b 字节CDN
    // P3: 各种省级/地方台自建CDN
    if (/zbbf2\.|ahbztv\.com|sctv\.com|tv\.cctv|cctv\.com/i.test(url)) return 300;
    if (/\.m3u8$/i.test(url))                                       return 150; // P4: 任何HLS裸链
    if (/\.mp3$|\.aac$/i.test(url))                                 return 100; // P5: 任何MP3裸链
    // P9 satellitepull排最后 (即使strip了wsSession参数，这个CDN本身连通率不如ngcdn官方)
    if (/satellitepull\.cnr\.cn/i.test(url))                        return 5;
    return 50; // unknown = 中性偏低
  }
  function labelOfCdn(url) {
    if (!url) return '未知线路';
    if (/ngcdn00[12]\.cnr\.cn/i.test(url)) return '央广官方CDN';
    if (/ngcdn\.cnr\.cn/i.test(url))       return '央广CDN';
    if (/satellitepull\.cnr\.cn/i.test(url)) return '央广卫星pull';
    if (/qtfm\.cn|qingting/i.test(url))    return '蜻蜓FM';
    if (/xmcdn|ximalaya/i.test(url))       return '喜马拉雅';
    if (/alicdn|myalicdn/i.test(url))      return '阿里云CDN';
    if (/mp3$/i.test(url))                 return 'MP3直链';
    try { const m = url.match(/https?:\/\/([^\/:]+)/); if (m) return m[1].substring(0, 16); } catch(e) {}
    return '线路';
  }
  // finalRadio声明在块外(ES5 var，非块级作用域)，无论走那个分支都能取到最终值
  var finalRadio = uniqueRadio; // 默认=不合并=V102d稳定态1652台
  var mergedRadio = []; // ⭐ V105修复：mergedRadio也声明在块外，ENABLE_MERGE=false时不会ReferenceError（即使第1100行已改用finalRadio）
  if (!ENABLE_MERGE) {
    console.log('[V105 合并开关] ENABLE_MERGE=false → 跳过合并(保持V102d完全稳定态)，uniqueRadio='+uniqueRadio.length+'台，直接作为finalRadio返回。wsSession strip防御永久生效(44个satellitepull源已删除过期wsSession参数)。');
    // 给每台手动挂urls[]=单元素数组(兼容UI未来可能访问ch.urls不报错)
    for (let si = 0; si < uniqueRadio.length; si++) {
      if (!uniqueRadio[si].urls) uniqueRadio[si].urls = [{ url: uniqueRadio[si].url, cdn: labelOfCdn(uniqueRadio[si].url), priority: cdnPriorityOf(uniqueRadio[si].url) }];
      if (!uniqueRadio[si].lineLabels) uniqueRadio[si].lineLabels = ['线路1 · ' + labelOfCdn(uniqueRadio[si].url)];
    }
    // finalRadio = uniqueRadio; 已经在上面设为默认了
  } else {
    // ============ ENABLE_MERGE=true：启用完整合并功能 ============
  const byNameMap = new Map();
  let mergePairs = 0;
  for (let i = 0; i < uniqueRadio.length; i++) {
    const r = uniqueRadio[i];
    const normName = (r.name || '').trim();
    if (!normName) continue;
    let entry = byNameMap.get(normName);
    if (!entry) {
      // 首次出现：作为主条目模板
      entry = JSON.parse(JSON.stringify(r)); // deep copy防止污染
      entry.urls = [{ url: r.url, cdn: labelOfCdn(r.url), priority: cdnPriorityOf(r.url) }];
      byNameMap.set(normName, entry);
    } else {
      // 合并：把当前r的URL添加到urls[]数组，CDN去重
      let dupUrl = false;
      for (let k = 0; k < entry.urls.length; k++) {
        if (entry.urls[k].url === r.url) { dupUrl = true; break; }
      }
      if (!dupUrl) {
        entry.urls.push({ url: r.url, cdn: labelOfCdn(r.url), priority: cdnPriorityOf(r.url) });
        mergePairs++;
      }
      // 保留更多元信息：如果新r里color有颜色但旧entry没有，就继承
      if ((!entry.color || entry.color==='#d4af37') && r.color && r.color!=='#d4af37') entry.color = r.color;
      if (!entry.frequency && r.frequency)  entry.frequency = r.frequency;
      if (!entry.description && r.description) entry.description = r.description;
    }
  }
  // 排序：每个entry.urls[] 按priority DESC → priority最高的(900=ngcdn002官方)放urls[0]=默认播放！
  mergedRadio.length = 0; // ⭐ V105修复：已经在块外声明了var mergedRadio=[]，这里清空复用（不能再const声明，否则块级作用域覆盖）
  for (const [name, entry] of byNameMap.entries()) {
    entry.urls.sort(function(a, b) { return (b.priority||0) - (a.priority||0); });
    // 默认播放url = urls[0].url (最高CDN优先级的那条，V104最核心的修复！)
    entry.url = entry.urls[0].url;
    // lineLabels: 给UI展示，"线路1(央广官方CDN) / 线路2(蜻蜓FM)"
    entry.lineLabels = entry.urls.map(function(u, i) { return '线路'+(i+1)+' · '+u.cdn; });
    mergedRadio.push(entry);
  }
  console.log('[V104 合并统计] 去重前uniqueRadio='+uniqueRadio.length+' → 按name合并后mergedRadio='+mergedRadio.length+'，有'+mergePairs+'条重复线路被合并(多线路电台='+(byNameMap.size - uniqueRadio.length + mergePairs < 0 ? 0 : (function(){let c=0; byNameMap.forEach(e=>{if(e.urls.length>1)c++}); return c})())+') 个电台≥2条线路)');
  // 额外打印前15个多线路电台的线路排序，验证ngcdn官方是否排在线路1
  let debugMulti = [];
  byNameMap.forEach(function(e, nm) {
    if (e.urls.length > 1 && debugMulti.length < 15) {
      debugMulti.push({ name: nm, lines: e.urls.map(u=>u.cdn+':'+(u.priority||0)).join(' > '), default: e.url.substring(0,55) });
    }
  });
  console.log('[V104 合并调试] 前15个多线路电台(CDN priority DESC排序):', debugMulti);
  // ============ ENABLE_MERGE=true分支结束：finalRadio=mergedRadio ============
  finalRadio = mergedRadio;
  }
  const regionCounts = {};
  const regionNames = new Set();
  const debugInfo = [];
  const duplicateInfo = [];
  // V105: finalRadio 已在前面正确赋值(ENABLE_MERGE=false=uniqueRadio=1652；true=mergedRadio=1623)
  for (let i = 0; i < finalRadio.length; i++) {
    const r = finalRadio[i];
    let desc = r.description;
    desc = desc.trim().replace(/[\uFEFF]/g, '').replace(/\s+/g, '').replace(/[\uFF01-\uFF5E]/g, function(c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    regionNames.add(desc);
    regionCounts[desc] = (regionCounts[desc] || 0) + 1;
    if (desc === '全国' || desc.includes('中央') || desc.includes('电视') || desc.includes('香港')) {
      debugInfo.push({ name: r.name, desc: desc, descCode: desc.charCodeAt(0), descLength: desc.length });
    }
  }
  console.log('分类统计:', regionCounts);
  console.log('所有分类名称:', [...regionNames]);
  console.log('中央/电视/香港分类调试:', debugInfo.slice(0, 30));
  let total = 0;
  for (const key in regionCounts) {
    total += regionCounts[key];
    if (key.includes('全国') || key.includes('海外') || key.includes('香港')) {
      duplicateInfo.push({ key: key, charCode: key.charCodeAt(0), length: key.length, count: regionCounts[key] });
    }
  }
  console.log('重复分类详情:', duplicateInfo);
  console.log('分类数量总和:', total, ', finalRadio长度(合并分支=mergedRadio，不合并分支=uniqueRadio):', finalRadio.length, ', uniqueRadio(URL处理+strip wsSession后):', uniqueRadio.length);
  console.log('分类统计对象的键数量:', Object.keys(regionCounts).length);
  const hongKongStations = finalRadio.filter(r => r.name.includes('香港'));
  console.log('所有包含"香港"的电台:', hongKongStations.map(r => ({ name: r.name, desc: r.description })));
  const unclassifiedStations = finalRadio.filter(r => !regions.some(reg => reg.name === r.description));
  console.log('未被正确归类的电台数量:', unclassifiedStations.length);
  console.log('未被正确归类的电台示例:', unclassifiedStations.slice(0, 10).map(r => ({ name: r.name, desc: r.description })));
  
  const tv = [];
  
  for (let i = 0; i < data.tv.length; i++) {
    const ch = data.tv[i];
    const name = (ch.name || '').trim();
    const url = (ch.url || '').trim();
    
    if (isGarbage(name)) continue;
    if (!url || !isValidUrl(url)) continue;
    
    const region = ch.description && isRegionValid(ch.description) ? ch.description : detectRegion(name);
    const frequency = normalizeFrequency(ch.frequency, name);
    
    tv.push({
      id: ch.id,
      name: name,
      frequency: frequency,
      url: url,
      color: ch.color || '#d4af37',
      description: region,
      category: ch.category || 'tv-documentary'
    });
  }
  
  // V104核心：用mergedRadio返回(按name合并+CDN优先级排序ngcdn002官方线路1)，不是uniqueRadio
  return { radio: finalRadio, tv };
  // V102d 最后兜底catch：任何异常都至少返回backupStations保底（backupStations里120+台，保证用户永远能看到电台）
  } catch (processFatal) {
    console.error('V104 processChannels FATAL exception (fallback to backupStations only): ' + processFatal.message, processFatal.stack);
    try {
      const fallback = { radio: [], tv: [] };
      for (let bi = 0; bi < backupStations.length; bi++) {
        const s = backupStations[bi];
        fallback.radio.push({
          id: 'fb'+bi, name: s.name, frequency: s.frequency || '网络电台',
          url: s.url, color: '#d4af37', description: s.region || '全国', category: s.category || '综合'
        });
      }
      console.warn('V102d processChannels FATAL resolved: fallback radio.length=' + fallback.radio.length);
      return fallback;
    } catch (ultraFatal) { return { radio:[], tv:[] }; }
  }
}

// Electron版真实分类顺序（来自app.js provinceOrder）
const ELECTRON_REGION_ORDER = [
  '全部','收藏','历史','个人',
  '全国','中央','电视伴音','国际',
  '北京','上海','天津','重庆',
  '香港','澳门','台湾',
  '河北','山西','辽宁','吉林','黑龙江',
  '江苏','浙江','安徽','福建','江西','山东',
  '河南','湖北','湖南','广东','广西','海南',
  '四川','贵州','云南','西藏',
  '陕西','甘肃','青海','宁夏','新疆',
  '内蒙古','海外','其它'
];

// === 100% Electron buildStationTree() 排序逻辑 字节级复刻 ===
// provinceOrder + cityOrder + localeCompare(zh-CN)，严格确保每个region里的电台顺序和Electron MENU面板完全一致
const ELECTRON_PROVINCE_ORDER = [
  '全国', '中央', '电视伴音', '国际',
  '北京', '上海', '天津', '重庆',
  '香港', '澳门', '台湾',
  '河北', '山西', '辽宁', '吉林', '黑龙江',
  '江苏', '浙江', '安徽', '福建', '江西', '山东',
  '河南', '湖北', '湖南', '广东', '广西', '海南',
  '四川', '贵州', '云南', '西藏',
  '陕西', '甘肃', '青海', '宁夏', '新疆',
  '内蒙古', '海外', '个人', '其它'
];
const ELECTRON_CITY_ORDER = {
  '北京': ['北京'],
  '上海': ['上海'],
  '天津': ['天津'],
  '重庆': ['重庆', '渝中', '江北', '南岸', '北碚', '万盛', '双桥', '渝北', '巴南'],
  '河北': ['石家庄', '唐山', '秦皇岛', '邯郸', '邢台', '保定', '张家口', '承德', '沧州', '廊坊', '衡水'],
  '山西': ['太原', '大同', '阳泉', '长治', '晋城', '朔州', '晋中', '运城', '忻州', '临汾', '吕梁'],
  '辽宁': ['沈阳', '大连', '鞍山', '抚顺', '本溪', '丹东', '锦州', '营口', '阜新', '辽阳', '盘锦', '铁岭', '朝阳', '葫芦岛'],
  '吉林': ['长春', '吉林', '四平', '辽源', '通化', '白山', '松原', '白城', '延边'],
  '黑龙江': ['哈尔滨', '齐齐哈尔', '鸡西', '鹤岗', '双鸭山', '大庆', '伊春', '佳木斯', '七台河', '牡丹江', '黑河', '绥化', '大兴安岭'],
  '江苏': ['南京', '无锡', '徐州', '常州', '苏州', '南通', '连云港', '淮安', '盐城', '扬州', '镇江', '泰州', '宿迁'],
  '浙江': ['杭州', '宁波', '温州', '嘉兴', '湖州', '绍兴', '金华', '衢州', '舟山', '台州', '丽水'],
  '安徽': ['合肥', '芜湖', '蚌埠', '淮南', '马鞍山', '淮北', '铜陵', '安庆', '黄山', '滁州', '阜阳', '宿州', '巢湖', '六安', '亳州', '池州', '宣城'],
  '福建': ['福州', '厦门', '莆田', '三明', '泉州', '漳州', '南平', '龙岩', '宁德'],
  '江西': ['南昌', '景德镇', '萍乡', '九江', '新余', '鹰潭', '赣州', '吉安', '宜春', '抚州', '上饶'],
  '山东': ['济南', '青岛', '淄博', '枣庄', '东营', '烟台', '潍坊', '济宁', '泰安', '威海', '日照', '莱芜', '临沂', '德州', '聊城', '滨州', '菏泽'],
  '河南': ['郑州', '开封', '洛阳', '平顶山', '安阳', '鹤壁', '新乡', '焦作', '濮阳', '许昌', '漯河', '三门峡', '南阳', '商丘', '信阳', '周口', '驻马店'],
  '湖北': ['武汉', '黄石', '十堰', '宜昌', '襄樊', '鄂州', '荆门', '孝感', '荆州', '黄冈', '咸宁', '随州', '恩施'],
  '湖南': ['长沙', '株洲', '湘潭', '衡阳', '邵阳', '岳阳', '常德', '张家界', '益阳', '郴州', '永州', '怀化', '娄底', '湘西'],
  '广东': ['广州', '韶关', '深圳', '珠海', '汕头', '佛山', '江门', '湛江', '茂名', '肇庆', '惠州', '梅州', '汕尾', '河源', '阳江', '清远', '东莞', '中山', '潮州', '揭阳', '云浮'],
  '广西': ['南宁', '柳州', '桂林', '梧州', '北海', '防城港', '钦州', '贵港', '玉林', '百色', '贺州', '河池', '来宾', '崇左'],
  '海南': ['海口', '三亚'],
  '四川': ['成都', '自贡', '攀枝花', '泸州', '德阳', '绵阳', '广元', '遂宁', '内江', '乐山', '南充', '眉山', '宜宾', '广安', '达州', '雅安', '巴中', '资阳', '阿坝', '甘孜', '凉山'],
  '贵州': ['贵阳', '六盘水', '遵义', '安顺', '铜仁', '毕节', '黔西南', '黔东南', '黔南'],
  '云南': ['昆明', '曲靖', '玉溪', '保山', '昭通', '丽江', '普洱', '临沧', '楚雄', '红河', '文山', '西双版纳', '大理', '德宏', '怒江', '迪庆'],
  '西藏': ['拉萨', '昌都', '山南', '日喀则', '那曲', '阿里', '林芝'],
  '陕西': ['西安', '铜川', '宝鸡', '咸阳', '渭南', '延安', '汉中', '榆林', '安康', '商洛'],
  '甘肃': ['兰州', '嘉峪关', '金昌', '白银', '天水', '武威', '张掖', '平凉', '酒泉', '庆阳', '定西', '陇南', '临夏', '甘南'],
  '青海': ['西宁', '海东', '海北', '黄南', '海南', '果洛', '玉树', '海西'],
  '宁夏': ['银川', '石嘴山', '吴忠', '固原', '中卫'],
  '新疆': ['乌鲁木齐', '克拉玛依', '吐鲁番', '哈密', '昌吉', '博尔塔拉', '巴音郭楞', '阿克苏', '克孜勒苏', '喀什', '和田', '伊犁', '塔城', '阿勒泰'],
  '内蒙古': ['呼和浩特', '包头', '乌海', '赤峰', '通辽', '鄂尔多斯', '呼伦贝尔', '巴彦淖尔', '乌兰察布', '兴安', '锡林郭勒', '阿拉善'],
  '香港': ['香港'],
  '澳门': ['澳门'],
  '台湾': ['台北', '高雄', '台中', '台南', '新竹', '嘉义'],
  '全国': [],
  '中央': [],
  '国际': [],
  '电视伴音': [],
  '海外': []
};
// 单个region内的电台排序：先按cityOrder匹配城市名index排，否则localeCompare(zh-CN)
function electronStationSort(regionName, stationsArr) {
  const stationsCopy = stationsArr.slice();
  stationsCopy.sort(function(a, b) {
    var nameA = a.name, nameB = b.name;
    if (!ELECTRON_CITY_ORDER[regionName]) {
      return nameA.localeCompare(nameB, 'zh-CN');
    }
    var cities = ELECTRON_CITY_ORDER[regionName];
    var idxA = -1, idxB = -1;
    for (var i = 0; i < cities.length; i++) { if (nameA.indexOf(cities[i]) !== -1) { idxA = i; break; } }
    for (var i = 0; i < cities.length; i++) { if (nameB.indexOf(cities[i]) !== -1) { idxB = i; break; } }
    if (idxA !== idxB) return idxA - idxB;
    return nameA.localeCompare(nameB, 'zh-CN');
  });
  return stationsCopy;
}

/* ============ 加载频道（100% Electron逻辑 - 直接调processChannels） ============ */
// V157 加固：DATA_VERSION升级导致 forceReset=true 时，从旧 saved radio_channels
//   按 id 合并用户编辑字段（地区/频率/分类/Logo/主题色/播放地址/名称），避免编辑内容被覆盖复位
//   用户可编辑字段 = 管理台编辑表单 (submitEditForm/submitPersonalForm) 可修改的所有字段
const USER_EDITABLE_FIELDS = ['description','region','frequency','category','logo',
                              'theme_color','color','url','name','cityOrder','_edited'];
// V161: 检测乱码地区名（含U+FFFD替换符/控制符/私用区，或完全不含中日韩文字与字母数字）
function isGarbledRegion(name) {
  if (!name) return false;
  const s = String(name);
  if (s.indexOf('\uFFFD') >= 0) return true;
  let hasText = false;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
        (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5A) ||
        (cp >= 0x61 && cp <= 0x7A)) { hasText = true; break; }
  }
  return !hasText;
}
// V161: 把频道里乱码的 description 归入「其它」，防止左侧导航出现乱码分类
function sanitizeChannelDescriptions() {
  var fixed = 0;
  var walk = function(arr) {
    if (!Array.isArray(arr)) return;
    arr.forEach(function(c) {
      if (c && isGarbledRegion(c.description)) { c.description = '其它'; fixed++; }
    });
  };
  walk(state.channels && state.channels.radio);
  walk(state.channels && state.channels.tv);
  if (fixed > 0) console.log('[V161 sanitizeChannelDescriptions] 已把 ' + fixed + ' 个乱码地区归入「其它」');
}
function loadChannels() {
  const STORAGE_KEY = 'radio_channels';
  try {
    const savedVer = localStorage.getItem(DATA_VERSION_KEY);
    const forceReset = savedVer !== DATA_VERSION;
    console.log('[V157 loadChannels]['+APP_VERSION+'] savedVer='+(savedVer||'')+' required='+DATA_VERSION+' forceReset='+forceReset);

    // 版本没变时从 localStorage 加载，保留用户编辑（地区、频率等）
    if (!forceReset) {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        state.channels = JSON.parse(saved);
        sanitizeChannelDescriptions();
        console.log('[loadChannels] 从 localStorage 加载（保留用户编辑），总台数='+(state.channels.radio||[]).length);
        return;
      }
    }

    // ============= V157: 版本变了 → 从 CHANNEL_DATA 重新处理，但先把用户编辑字段合并回来 =============
    // Step1: 先读取旧 saved radio_channels，构建 id→编辑值 映射
    var userEditsMap = {}; // { [id]: {field: value, ...} }
    var userPersonalStations = []; // 保留用户自建电台
    try {
      const oldStr = localStorage.getItem(STORAGE_KEY);
      if (oldStr) {
        const oldObj = JSON.parse(oldStr);
        var collectFn = function(arr) {
          if (!Array.isArray(arr)) return;
          arr.forEach(function(c) {
            if (!c || !c.id) return;
            // 自建电台（isPersonal/userCreated）或者不在CHANNEL_DATA原始列表里的用户添加台 → 整体保留
            if (c.isPersonal || c.userCreated || c._userAdded) {
              userPersonalStations.push(JSON.parse(JSON.stringify(c)));
              return;
            }
            var edits = {};
            var hasEdit = false;
            USER_EDITABLE_FIELDS.forEach(function(f) {
              if (c[f] !== undefined && c[f] !== null && c[f] !== '') { edits[f] = c[f]; hasEdit = true; }
            });
            if (hasEdit) userEditsMap[c.id] = edits;
          });
        };
        collectFn(oldObj.radio);
        collectFn(oldObj.tv);
      }
      console.log('[V157 loadChannels] 从旧缓存恢复用户编辑：'+Object.keys(userEditsMap).length+' 个预置电台有编辑值，自建电台 '+userPersonalStations.length+' 个');
    } catch(parseErr) {
      console.warn('[V157 loadChannels] 解析旧saved失败，无法合并用户编辑: '+parseErr);
      userEditsMap = {}; userPersonalStations = [];
    }

    // 版本变了或无保存数据，从 CHANNEL_DATA 重新处理
    if (typeof CHANNEL_DATA !== 'undefined' && CHANNEL_DATA.radio) {
      const processed = processChannels(CHANNEL_DATA);
      // Step2: 合并 userEditsMap 到 processed
      var mergedCount = 0;
      var mergeToArr = function(arr) {
        if (!Array.isArray(arr)) return;
        arr.forEach(function(c) {
          if (!c || !c.id) return;
          var edits = userEditsMap[c.id];
          if (!edits) return;
          USER_EDITABLE_FIELDS.forEach(function(f) {
            if (edits[f] !== undefined) { c[f] = edits[f]; }
          });
          mergedCount++;
        });
      };
      mergeToArr(processed.radio);
      mergeToArr(processed.tv);
      console.log('[V157 loadChannels] 合并到新processed：'+mergedCount+' 个电台编辑值已还原');
      // Step3: 把自建台追加到 radio 列表末尾（去重：id相同跳过）
      if (userPersonalStations.length > 0) {
        if (!Array.isArray(processed.radio)) processed.radio = [];
        var existIds = {};
        processed.radio.forEach(function(c) { if (c && c.id) existIds[c.id] = true; });
        userPersonalStations.forEach(function(ps) {
          if (ps && ps.id && !existIds[ps.id]) { processed.radio.push(ps); existIds[ps.id] = true; }
        });
        console.log('[V157 loadChannels] 恢复自建个人电台 '+userPersonalStations.length+' 个到列表');
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(processed));
      localStorage.setItem(DATA_VERSION_KEY, DATA_VERSION);
      state.channels = processed;
      sanitizeChannelDescriptions();

      // 校验统计
      const gucheng = processed.radio.filter(c => /故城/.test(c.name));
      const jjzsArr = processed.radio.filter(c => /经济之声/.test(c.name));
      const centralRaw = processed.radio.filter(c => c.description === '中央');
      const centralSorted = electronStationSort('中央', centralRaw);
      console.log('[loadChannels] 总台数='+processed.radio.length+' 中央='+centralSorted.length+' 故城='+gucheng.length);
      if (jjzsArr.length > 0) {
        console.log('[loadChannels] 经济之声URL='+jjzsArr[0].url+' id='+jjzsArr[0].id);
      }
      return;
    }
  } catch (e) {
    console.warn('[V157 loadChannels] 处理频道数据失败', e);
  }
  // fallback
  try {
    const saved = localStorage.getItem('radio_channels');
    if (saved) { state.channels = JSON.parse(saved); }
    else { state.channels = { radio: [], tv: [] }; }
    sanitizeChannelDescriptions();
  } catch(e2) {
    state.channels = { radio: [], tv: [] };
  }
}

/* ============ CATEGORIES (严格Electron顺序 - 左侧垂直导航) ============ */
// 不参与「省份排序」的前几个功能分类（永远在最前）
const HEADER_CATEGORIES = ['全部', '收藏', '历史', '个人', '全国', '中央', '电视伴音', '国际'];
// 不参与「省份排序」的后几个功能分类（永远在最后）
const TAIL_CATEGORIES = ['海外', '其它', '自定义'];

function getCategoryList() {
  const all = [...state.channels.radio || [], ...state.channels.tv || []];
  const hasRegion = {};
  all.forEach(ch => {
    const d = ch.description || '全国';
    hasRegion[isGarbledRegion(d) ? '其它' : d] = true;  // V161: 乱码地区归入「其它」
  });
  if (state.favorites.length) hasRegion['收藏'] = true;
  if (state.history.length) hasRegion['历史'] = true;
  hasRegion['全部'] = true;
  hasRegion['个人'] = true;
  const MAIN_REGIONS = ELECTRON_REGION_ORDER.filter(r => !['其它'].includes(r));
  let list = MAIN_REGIONS.filter(r => {
    if (['全部','收藏','历史','个人'].includes(r)) return true;
    return true;
  });
  Object.keys(hasRegion).forEach(r => { if (!list.includes(r)) list.push(r); });

  // ---- pinnedProvince 置顶：把定位到的省份放到 HEADER_CATEGORIES 之后第一个位置 ----
  const pinned = state.pinnedProvince || '';
  if (pinned && list.indexOf(pinned) > 0) {
    const headerIdx = Math.max(...HEADER_CATEGORIES.map(h => list.indexOf(h)).filter(i => i >= 0));
    const insertAfter = headerIdx >= 0 ? headerIdx : -1;
    const curIdx = list.indexOf(pinned);
    if (curIdx > insertAfter) {
      list.splice(curIdx, 1);
      list.splice(insertAfter + 1, 0, pinned);
    }
  }
  return list;
}

function updateTopRegion() {
  if (els.topRegion) {
    const map = { '全部':'全部', '收藏':'收藏', '历史':'历史', '自定义':'自定义', '个人':'个人' };
    els.topRegion.textContent = map[state.currentFilter] || state.currentFilter;
  }
}

function renderCategories() {
  const cats = getCategoryList();
  console.log('[renderCategories] pinnedProvince=' + (state.pinnedProvince||'') + ' cats[0..12]=' + cats.slice(0,13).join(','));
  const labelMap = {
    '全部':'全部', '收藏':'收藏', '历史':'历史',
    '全国':'全国', '中央':'中央', '电视伴音':'伴音', '国际':'国际',
    '北京':'北京', '上海':'上海', '天津':'天津', '重庆':'重庆',
    '香港':'香港', '澳门':'澳门', '台湾':'台湾',
    '河北':'河北', '山西':'山西', '辽宁':'辽宁', '吉林':'吉林', '黑龙江':'龙江',
    '江苏':'江苏', '浙江':'浙江', '安徽':'安徽', '福建':'福建', '江西':'江西', '山东':'山东',
    '河南':'河南', '湖北':'湖北', '湖南':'湖南', '广东':'广东', '广西':'广西', '海南':'海南',
    '四川':'四川', '贵州':'贵州', '云南':'云南', '西藏':'西藏',
    '陕西':'陕西', '甘肃':'甘肃', '青海':'青海', '宁夏':'宁夏', '新疆':'新疆',
    '内蒙古':'内蒙', '海外':'海外', '其它':'其它',
    '自定义':'自定义', '个人':'个人'
  };
  // 通用兜底：带「省/市/自治区/维吾尔/壮族/回族」后缀的去掉后截前 2 字
  const shortenRegion = (r) => {
    if (!r) return r;
    if (labelMap[r]) return labelMap[r];
    let s = String(r)
      .replace(/自治区$/g, '').replace(/省$/g, '').replace(/市$/g, '')
      .replace(/维吾尔$/g, '').replace(/壮族$/g, '').replace(/回族$/g, '');
    if (s.length > 2) s = s.slice(0, 2);
    return s || r;
  };
  els.sideNav.innerHTML = cats.map(c => {
    const label = shortenRegion(c);
    const active = state.currentFilter === c ? 'active' : '';
    return `<button class="side-nav-item ${active}" data-filter="${escapeHtml(c)}">${escapeHtml(label)}</button>`;
  }).join('');
  els.sideNav.querySelectorAll('.side-nav-item').forEach(tab => {
    tab.addEventListener('click', () => {
      state.currentFilter = tab.dataset.filter;
      state.searchQuery = '';
      renderCategories();
      renderChannels();
      updateTopRegion();
      // 滚动到可见
      tab.scrollIntoView({ behavior:'smooth', block:'nearest', inline:'start' });
    });
  });
}

/* ============ CHANNELS - 列表式（100% Electron buildStationTree排序逻辑） ============ */
function getFilteredChannels() {
  // V126: 个人Tab → 显示用户自建电台
  if (state.currentFilter === '个人') {
    const userList = state.userStations.map(s => ({
      id: s.id,
      name: s.name,
      url: s.url,
      frequency: s.frequency || '',
      description: s.description || '',
      category: s.category || '综合',
      color: s.color || '#d7263d',
      isUserStation: true
    }));
    // V176: 个人电台也按地区(省份)分组排序，与省市tab/收藏tab逻辑一致：相同地区电台排一块。
    //   有正常地区(description) → 按省份分组 → 组内 electronStationSort(cityOrder+localeCompare)
    //   → 省份顺序按 ELECTRON_PROVINCE_ORDER + localeCompare；无地区/乱码地区的电台放最后。
    const regionGroups = {};
    const noRegion = [];
    userList.forEach(function(ch) {
      const region = ch.description;
      if (region && !isGarbledRegion(region)) {
        if (!regionGroups[region]) regionGroups[region] = [];
        regionGroups[region].push(ch);
      } else {
        noRegion.push(ch);
      }
    });
    Object.keys(regionGroups).forEach(function(rName) {
      regionGroups[rName] = electronStationSort(rName, regionGroups[rName]);
    });
    const regionNames = Object.keys(regionGroups);
    regionNames.sort(function(a, b) {
      const idxA = ELECTRON_PROVINCE_ORDER.indexOf(a);
      const idxB = ELECTRON_PROVINCE_ORDER.indexOf(b);
      if (idxA !== idxB) return idxA - idxB;
      return a.localeCompare(b, 'zh-CN');
    });
    const flat = [];
    regionNames.forEach(function(r) { flat.push(...regionGroups[r]); });
    return [...flat, ...noRegion];
  }

  let list = [...state.channels.radio || [], ...state.channels.tv || []];

  // 功能分类：收藏 - 按省份分组+electronStationSort排序，有地区的个人电台参与省份排序，无地区的放最后
  if (state.currentFilter === '收藏') {
    const favNormal = list.filter(ch => state.favorites.includes(ch.id));
    const favUser = state.userStations
      .filter(s => state.favorites.includes(s.id))
      .map(s => ({
        id: s.id, name: s.name, url: s.url,
        frequency: s.frequency || '', description: s.description || '',
        category: s.category || '综合', color: s.color || '#d7263d',
        isUserStation: true
      }));
    // 普通收藏按省份分组+electronStationSort排序
    const regionGroups = {};
    favNormal.forEach(function(ch) {
      const region = ch.description || '其它';
      if (!regionGroups[region]) regionGroups[region] = [];
      regionGroups[region].push(ch);
    });
    // 有地区的个人电台参与省份分组排序，无地区的放最后
    const favUserNoRegion = [];
    favUser.forEach(function(ch) {
      const region = ch.description;
      if (region) {
        if (!regionGroups[region]) regionGroups[region] = [];
        regionGroups[region].push(ch);
      } else {
        favUserNoRegion.push(ch);
      }
    });
    Object.keys(regionGroups).forEach(function(rName) {
      regionGroups[rName] = electronStationSort(rName, regionGroups[rName]);
    });
    const regionNames = Object.keys(regionGroups);
    regionNames.sort(function(a, b) {
      const idxA = ELECTRON_PROVINCE_ORDER.indexOf(a);
      const idxB = ELECTRON_PROVINCE_ORDER.indexOf(b);
      if (idxA !== idxB) return idxA - idxB;
      return a.localeCompare(b, 'zh-CN');
    });
    const flat = [];
    regionNames.forEach(function(r) { flat.push(...regionGroups[r]); });
    // 有地区的个人电台已参与省份排序；没有地区的个人电台放最后
    return [...flat, ...favUserNoRegion];
  }
  if (state.currentFilter === '历史') {
    // V163: 严格按播放时间倒序（最近播放在最上），普通电台与个人电台按时间混合排列
    const byId = {};
    list.forEach(function(ch) { byId[ch.id] = ch; });
    state.userStations.forEach(function(s) {
      byId[s.id] = {
        id: s.id, name: s.name, url: s.url,
        frequency: s.frequency || '', description: s.description || '',
        category: s.category || '综合', color: s.color || '#d7263d',
        isUserStation: true
      };
    });
    return state.history.map(function(id) { return byId[id]; }).filter(Boolean);
  }
  if (state.currentFilter === '自定义') return list.filter(ch => state.customChannels.includes(ch.id));

  // 按description分region，每个region内严格按Electron排序
  const regionGroups = {};
  list.forEach(function(ch) {
    const rawDesc = ch.description || '其它';
    const region = isGarbledRegion(rawDesc) ? '其它' : rawDesc;  // V161: 乱码地区归入「其它」
    if (!regionGroups[region]) regionGroups[region] = [];
    regionGroups[region].push(ch);
  });

  // 每个region内部排序（先cityOrder，再localeCompare zh-CN）
  Object.keys(regionGroups).forEach(function(rName) {
    regionGroups[rName] = electronStationSort(rName, regionGroups[rName]);
  });

  // 功能：全部 - 先按provinceOrder排region顺序，再region内顺序展平
  if (state.currentFilter === '全部') {
    const regionNames = Object.keys(regionGroups);
    regionNames.sort(function(a, b) {
      const idxA = ELECTRON_PROVINCE_ORDER.indexOf(a);
      const idxB = ELECTRON_PROVINCE_ORDER.indexOf(b);
      if (idxA !== idxB) return idxA - idxB;
      return a.localeCompare(b, 'zh-CN');
    });
    const flat = [];
    regionNames.forEach(function(r) { flat.push(...regionGroups[r]); });
    return flat;
  }

  // 其它具体region筛选
  return regionGroups[state.currentFilter] || list.filter(ch => (ch.description||'') === state.currentFilter);
}

function makeChannelListItem(ch, opts) {
  opts = opts || {};
  const isActive = state.currentChannel && state.currentChannel.id === ch.id;
  const isFavorite = state.favorites.includes(ch.id);
  const isUser = !!ch.isUserStation;
  const mode = opts.mode || 'browse';  // 'browse'浏览页(个人列表) / 'manage'管理页 / 其它普通列表
  const el = document.createElement('div');
  el.className = 'channel-list-item' + (isActive ? ' active' : '');
  const subParts = [];
  if (ch.frequency) subParts.push(ch.frequency);
  if (ch.description) subParts.push(ch.description);
  const hasLive = isActive && !!state.isPlaying;

  let actionsHtml;
  if (isUser && mode === 'manage') {
    // 管理页：显示编辑/删除
    actionsHtml = `
      <div class="channel-list-user-actions">
        <button class="channel-list-act edit" data-act="edit" data-id="${ch.id}" aria-label="编辑">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <button class="channel-list-act del" data-act="del" data-id="${ch.id}" aria-label="删除">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>
      </div>
    `;
  } else {
    // 浏览页(个人列表)/收藏/历史/其它：统一显示收藏toggle
    actionsHtml = `
      <button class="channel-list-fav ${isFavorite?'active':''}" data-id="${ch.id}" aria-label="收藏">
        <svg viewBox="0 0 24 24" fill="${isFavorite?'currentColor':'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      </button>
    `;
  }
  el.innerHTML = `
    <div class="channel-list-logo">${getChannelIcon(ch)}</div>
    <div class="channel-list-info">
      <div class="channel-list-name">${escapeHtml(ch.name||'电台')}</div>
      <div class="channel-list-sub">
        ${hasLive ? `<span class="channel-list-badge live">直播中</span>` : ''}
        <span>${escapeHtml(subParts.join(' · ') || '网络电台')}</span>
      </div>
    </div>
    ${actionsHtml}
  `;
  el.addEventListener('click', e => {
    if (e.target.closest('.channel-list-fav') || e.target.closest('.channel-list-act')) return;
    playChannel(ch);
  });
  const favBtn = el.querySelector('.channel-list-fav');
  if (favBtn) favBtn.addEventListener('click', e => {
    e.stopPropagation();
    toggleFavorite(ch.id);
  });
  el.querySelectorAll('.channel-list-act').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      if (act === 'edit') openPersonalEdit(id);
      else if (act === 'del') deleteUserStation(id);
    });
  });
  return el;
}

function renderChannels() {
  let channels = getFilteredChannels();
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    channels = channels.filter(ch =>
      (ch.name||'').toLowerCase().includes(q) ||
      (ch.frequency||'').toLowerCase().includes(q) ||
      (ch.description||'').toLowerCase().includes(q)
    );
  }
  els.channelList.innerHTML = '';
  // V126: 个人Tab → 顶部显示"添加电台"按钮条
  if (state.currentFilter === '个人') {
    const bar = document.createElement('div');
    bar.className = 'personal-bar';
    bar.innerHTML = `
      <div class="personal-bar-info">
        <div class="personal-bar-title">📻 自建</div>
        <span class="personal-bar-count">${state.userStations.length}</span>
      </div>
      <div class="personal-bar-actions">
        <button class="personal-add-btn" id="personalBatchBtn" title="批量导入" style="color:var(--text-primary)!important;background:var(--surface-hover);border:1px solid var(--border);white-space:nowrap;">📥 批量</button>
        <button class="personal-add-btn" id="personalAddBtn" style="color:var(--text-primary)!important;background:var(--surface-hover);border:1px solid var(--border);white-space:nowrap;">➕ 添加</button>
      </div>
    `;
    els.channelList.appendChild(bar);
    const addBtn = bar.querySelector('#personalAddBtn');
    if (addBtn) addBtn.addEventListener('click', openPersonalAdd);
    const batchBtn = bar.querySelector('#personalBatchBtn');
    if (batchBtn) batchBtn.addEventListener('click', openPersonalBatch);
  }
  if (!channels.length) {
    if (state.currentFilter === '个人') {
      els.emptyState.querySelector('.empty-text').textContent = '还没有个人电台，点击上方"添加电台"创建';
    } else if (state.searchQuery) {
      els.emptyState.querySelector('.empty-text').textContent = '没有找到相关电台';
    } else if (state.currentFilter === '收藏') {
      els.emptyState.querySelector('.empty-text').textContent = '还没有收藏任何电台';
    } else if (state.currentFilter === '历史') {
      els.emptyState.querySelector('.empty-text').textContent = '还没有收听历史';
    } else if (state.currentFilter !== '全部') {
      els.emptyState.querySelector('.empty-text').textContent = state.currentFilter + '暂无电台';
    } else {
      els.emptyState.querySelector('.empty-text').textContent = '暂无电台';
    }
    els.emptyState.style.display = 'flex';
    return;
  }
  els.emptyState.style.display = 'none';

  const frag = document.createDocumentFragment();
  channels.forEach(ch => frag.appendChild(makeChannelListItem(ch)));
  els.channelList.appendChild(frag);
  // V140: 删除 V137-V139 中 unconditional 的 scrollIntoView(block:'center')——
  //       它导致"每次点击任何电台→列表强制滚动"的反体验bug。
  //       启动恢复lastPlay的滚动已在 init() 里通过双 rAF + pad=110px 处理好了（更精准）。
  //       用户手动切分类 / 点播放 / 搜索时，保持用户当前滚动位置不动 = 正确交互。
  setupLogoFallbacks();
}

/* ============ LOGO ============ */
function getChannelIcon(ch) {
  const n = ch.name||'', c = ch.category||'', f = ch.frequency||'', col = ch.color||'#e63946';
  if (ch.logo) {
    const local = ch.logo.startsWith('logos/') || !ch.logo.startsWith('http');
    return `<img src="${ch.logo}" data-name="${n}" data-cat="${c}" data-freq="${f}" data-color="${col}" class="channel-logo ${local?'local-logo':'remote-logo'}" alt=""/>`;
  }
  return generateSvgLogo(n, c, f, col);
}

function generateSvgLogo(name, cat, freq, color) {
  const catStr = (cat||'').toLowerCase();
  let firstChar = '';
  for (let i=0; i<name.length; i++) {
    const c = name[i];
    if (/[\u4e00-\u9fa5a-zA-Z0-9]/.test(c)) { firstChar = c; break; }
  }
  if (!firstChar) firstChar = '电';
  let subText = '';
  const fm = (freq||'').match(/FM\d+\.?\d*/i);
  const am = (freq||'').match(/AM\d+/i);
  if (fm) subText = fm[0].toUpperCase();
  else if (am) subText = am[0].toUpperCase();
  else if (catStr) subText = cat;
  if (subText.length > 6) subText = subText.substring(0,6);

  const cc = {
    '新闻':['#e74c3c','#c0392b'],'资讯':['#e74c3c','#c0392b'],
    '音乐':['#9b59b6','#8e44ad'],'影视':['#e67e22','#d35400'],
    '经济':['#f39c12','#d68910'],'财经':['#f39c12','#d68910'],
    '交通':['#3498db','#2980b9'],'体育':['#27ae60','#1e8449'],
    '文艺':['#e67e22','#d35400'],'生活':['#1abc9c','#16a085'],
    '教育':['#3498db','#2980b9'],'综合':['#7f8c8d','#6c7a7a']
  };
  let grad = [color, adjustColor(color,-22)];
  for (const k in cc) if (catStr.includes(k)) { grad = cc[k]; break; }
  const fontSize = firstChar.match(/[a-zA-Z0-9]/) ? 26 : 23;
  const rid = Math.random().toString(36).slice(2,8);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
    <defs>
      <linearGradient id="g1_${rid}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${grad[0]}"/>
        <stop offset="100%" stop-color="${grad[1]}"/>
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="46" height="46" rx="12" fill="url(#g1_${rid})"/>
    <text x="24" y="${subText?25:29}" text-anchor="middle" fill="white" font-size="${fontSize}" font-weight="700" font-family="PingFang SC, Microsoft YaHei, sans-serif">${firstChar}</text>
    ${subText?`<text x="24" y="39" text-anchor="middle" fill="rgba(255,255,255,0.9)" font-size="9" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-weight="500">${subText}</text>`:''}
  </svg>`;
}

function adjustColor(hex, amt) {
  const n = parseInt(hex.replace('#',''), 16);
  const r = Math.max(0, Math.min(255, (n>>16)+amt));
  const g = Math.max(0, Math.min(255, ((n>>8)&0xff)+amt));
  const b = Math.max(0, Math.min(255, (n&0xff)+amt));
  return '#' + (0x1000000 + r*0x10000 + g*0x100 + b).toString(16).slice(1);
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.replace('#',''), 16);
  return `rgba(${n>>16},${(n>>8)&0xff},${n&0xff},${a})`;
}

function setupLogoFallbacks() {
  document.querySelectorAll('.channel-logo').forEach(img => {
    img.onerror = function() {
      const name = this.dataset.name||'', cat=this.dataset.cat||'', freq=this.dataset.freq||'', col=this.dataset.color||'#d4af37';
      this.outerHTML = generateSvgLogo(name, cat, freq, col);
    };
    if (img.complete && img.naturalWidth===0) img.onerror();
  });
}

function getLogoInnerHtml(ch) {
  if (ch.logo) return `<img src="${ch.logo}" alt="" onerror="this.onerror=null;this.outerHTML='<div style=&quot;font-size:40px&quot;>📻</div>'"/>`;
  return `<span style="font-size:58px">📻</span>`;
}

/* ============ FAVORITE / HISTORY ============ */
function toggleFavorite(id) {
  const i = state.favorites.indexOf(id);
  if (i > -1) state.favorites.splice(i, 1); else state.favorites.push(id);
  saveFavorites();
  renderChannels();
  updatePlayerUI();
  showToast(i > -1 ? '已取消收藏' : '已添加收藏');
}
function addToHistory(id) {
  const i = state.history.indexOf(id);
  if (i > -1) state.history.splice(i, 1);
  state.history.unshift(id);
  if (state.history.length > 30) state.history.pop();
  saveHistory();
}

/* ============ PLAYBACK ============ */
const ICY_PORTS = new Set(['8000','8001','8002','8003','8004','8005','8006','8007','8008','8009','8010','8030','8080','8100','8200','8443','9000','9001','9300','7000','7001','7002','7003','7004','7005','7006','7007','7008','7009','7010','7400','7401','7402','7500','7600','7700','7800','7900']);
const AUDIO_EXT_RE = /\.(mp3|aac|m3u8|wav|ogg|flac|opus|m4a|wma|mp4|aacp)$/i;

function urlIsICYStream(url) {
  try {
    const u = new URL(url);
    const port = String(u.port || (u.protocol === 'https:' ? '443' : '80'));
    if (ICY_PORTS.has(port)) return true;
    const p = u.pathname.split('/').pop() || '';
    if (!AUDIO_EXT_RE.test(p) && !u.search) return true;
    return false;
  } catch (e) {
    return false;
  }
}

function ensureAllEngineHardStop() {
  // SOFT STOP (v56): do NOT call audio.pause() / do NOT clear src / do NOT
  // wipe event handlers. Chromium HTMLAudioElement already handles
  // reassignment of audio.src / hls.attachMedia correctly (old pending
  // requests are natively cancelled). Destructive audio.pause+src='' here
  // was the ROOT CAUSE of "play one word then stop" on card-click, because
  // it caused the native bridge to asynchronously release audio focus,
  // which races against the immediately-following audio.play() call and
  // results in the play promise resolving only to be immediately
  // interrupted / onpause fired. The bottom play bar never passes through
  // here, so it worked - we now match that behavior for card clicks too.
  if (state.hls) { try { state.hls.destroy(); } catch(ign){} state.hls = null; }
  state.isPlaying = false;
}

function stopPlaying(opts) {
  const fromNativeBroadcast = !!(opts && opts.fromNativeBroadcast);
  // stopPlaying is still used by the explicit "stop" UX paths and by the
  // native incoming pause broadcast. Keep it explicit but still avoid the
  // src/load wipe that can race the next immediate play path.
  if (state.hls) { try { state.hls.destroy(); } catch(ign){} state.hls = null; }
  if (state.audioElement) {
    try { state.audioElement.pause(); } catch(ign){}
  }
  if (!fromNativeBroadcast && hasNative()) {
    try { window.NativeRadio.stopPlayer && window.NativeRadio.stopPlayer(); } catch (ign) {}
  }
  state.isPlaying = false;
  setLastPlayPlaying(false);  // V183: 主动停止 → 取消冷启动自动续播
  if (els.fpStatus) els.fpStatus.textContent = '已暂停';
  updatePlayerUI();
  reportNativeState();
}

// ========================================================================
// V152 稳定性增强：网络切换自动重连 + 渲染崩溃恢复
// ========================================================================

/**
 * 网络恢复后自动重连当前电台（由 Java ConnectivityManager.NetworkCallback 调用）
 * 无线↔5G 切换时 hls.js/Icecast 可能断流，这里重新播放当前电台
 * 节流：10秒内只触发一次，避免网络抖动导致频繁重连
 */
window.handleNetworkReconnect = function() {
  try {
    if (!window.__lastPlayChannel && !state.currentChannel) {
      console.log('[NET-RECONNECT] 无当前电台，跳过');
      return;
    }
    // V172 FIX: 尊重用户意图——用户主动暂停/蓝牙断开期间，网络恢复不自动重播
    try {
      if (window._getUserPaused && window._getUserPaused()) { console.log('[NET-RECONNECT-V172] 用户已暂停，跳过自动重播'); return; }
      if (window._getBtAudioDisconnected && window._getBtAudioDisconnected()) { console.log('[NET-RECONNECT-V172] 蓝牙断开中，跳过自动重播'); return; }
    } catch(ign){}
    const now = Date.now();
    const last = window.__lastReconnectTs || 0;
    if (now - last < 10000) {
      console.log('[NET-RECONNECT] 节流跳过（10秒内已触发）');
      return;
    }
    window.__lastReconnectTs = now;
    const ch = window.__lastPlayChannel || state.currentChannel;
    console.log('[NET-RECONNECT] 网络已恢复，检查播放器状态: ' + (ch.name || ch.id || '?'));
    // 延迟500ms等网络真正稳定后再重连
    setTimeout(function() {
      try {
        if (ch && ch.url) {
          // V170/V172: ExoPlayer(WAKE_MODE_NETWORK)自带网络恢复+V164退避重试(预算8次约77秒)。
          //   正在播放/缓冲中→完全不打扰（Java门控已过滤大半，这里再兜底一次）；
          //   有源但停了(IDLE/错误)→先轻量resume（保留原MediaSource，ExoPlayer继续退避自愈），
          //   6秒复查仍无声才playChannel全量重载（兜底签名URL过期刷新）。
          if (state.playbackEngine === 'native' && hasNativeAudio()) {
            var _rst = null;
            try { _rst = nativeAudioRpc('status'); } catch(eStat) { console.warn('[NET-RECONNECT] status查询失败: ' + (eStat && eStat.message)); }
            if (_rst && _rst.isPlaying && _rst.hasSource) {
              console.log('[NET-RECONNECT-V172] 原生播放器仍在正常播放，跳过，避免打断');
              if (els.fpStatus) els.fpStatus.textContent = '正在直播';
              return;
            }
            if (_rst && _rst.hasSource && !_rst.isPlaying) {
              console.log('[NET-RECONNECT-V172] 有源但已停止(IDLE)，尝试轻量resume（保留退避自愈）');
              var rresp = null;
              try { rresp = nativeAudioRpc('resume'); } catch(eRes) { console.warn('[NET-RECONNECT] resume失败: ' + (eRes && eRes.message)); }
              state.isPlaying = !!(rresp && rresp.isPlaying);
              if (els.fpStatus) els.fpStatus.textContent = state.isPlaying ? '正在直播' : '已暂停';
              updatePlayerUI();
              if (state.isPlaying) {
                // 6秒后复查：resume后若仍无声(URL过期等)，playChannel全量重载兜底
                setTimeout(function() {
                  try {
                    var re = nativeAudioRpc('status');
                    if (re && re.hasSource && !re.isPlaying) {
                      console.log('[NET-RECONNECT-V172] resume后6秒复查仍无声 → playChannel全量重载兜底');
                      if (els.fpStatus) els.fpStatus.textContent = '网络已恢复，重新连接...';
                      playChannel(ch);
                    } else {
                      console.log('[NET-RECONNECT-V172] 复查正常(isPlaying=' + (re && re.isPlaying) + ')');
                    }
                  } catch(e2) {}
                }, 6000);
              } else {
                // resume立即返回未播放（罕见）→ 直接全量重载
                console.log('[NET-RECONNECT-V172] resume未生效 → playChannel全量重载');
                if (els.fpStatus) els.fpStatus.textContent = '网络已恢复，重新连接...';
                playChannel(ch);
              }
              return;
            }
            console.log('[NET-RECONNECT-V172] 无源(hasSource=false) → playChannel重载');
          }
          if (els.fpStatus) els.fpStatus.textContent = '网络已恢复，重新连接...';
          playChannel(ch);
        }
      } catch(e) { console.warn('[NET-RECONNECT] 重连失败:', e); }
    }, 500);
  } catch(e) { console.error('[NET-RECONNECT] 异常:', e); }
};

// ========================================================================
// V171 BT-AUDIO: 蓝牙音频输出状态处理（由 Java MainActivity.registerBtAudioMonitor 通过 evaluateJavascript 调用）
//   - 蓝牙断开/耳机拔出 → 立即暂停，设置 _btAudioDisconnected=true
//   - 蓝牙重连 → 清除 _btAudioDisconnected=false，允许后续自动恢复
//   关键：解锁屏幕后 checkAndResumePlayback 检查此标志，断开期间不自动恢复
//   V171a FIX: 本函数在顶层作用域，_btAudioDisconnected/_userPaused 是闭包变量（ReferenceError！）
//     必须通过 window._get/_setBtAudioDisconnected、window._setUserPaused 读写闭包标志。
// ========================================================================
window.handleBtAudioDisconnect = function() {
  try {
    if (window._getBtAudioDisconnected && window._getBtAudioDisconnected()) { console.log('[V171-BT] 已是断开状态，跳过'); return; }
    window._setBtAudioDisconnected && window._setBtAudioDisconnected(true);
    console.log('[V171-BT] 蓝牙音频输出丢失，暂停播放');
    // 标记用户暂停态，避免 watchdog/恢复逻辑误触发
    window._setUserPaused && window._setUserPaused(true);
    try {
      if (els.fpStatus) els.fpStatus.textContent = '蓝牙断开，已暂停';
      state.isPlaying = false;
      updatePlayerUI();
    } catch(ign){}
    // V173: 只 pause 不 stop！蓝牙断开是临时事件，保留播放源(MediaSource)，
    //   重连时 resume 秒级恢复；若 stopPlaying 会 clearMediaItems 清空源 + 释放FGS/锁，
    //   重连只能全量 playChannel 重载（慢、重新缓冲）。
    // V186: native 引擎不再发 pause RPC —— Java  noisy 接收器已执行 pauseForBt()
    //   （setPlayWhenReady(false)+wantPlaying=false+记录暂停时刻+emit pause bt:true，
    //   与普通 pause 语义完全等价）。再发一次普通 pause RPC 会被 Java 当成"用户手动暂停"
    //   而错误撤防 V186 整夜等待（实测断开0.8s后 wait-intent 被清、静音轨被释放）。
    try {
      if (state.playbackEngine === 'native' && hasNativeAudio()) {
        // no-op: Java pauseForBt 已暂停，仅同步 JS 状态（上方已置位）
      } else if (state.audioElement) {
        state.audioElement.pause();
      }
    } catch(e) { console.warn('[V173-BT] pause 异常:', e); }
    try { reportNativeState(); } catch(ign){}
    try { showToast('蓝牙断开，已暂停播放'); } catch(ign){}
    console.log('[V173-BT] disconnect 处理完成（已暂停并保留播放源，UI已同步）');
  } catch(e) { console.error('[V171-BT] disconnect 处理异常:', e); }
};

window.handleBtAudioReconnect = function() {
  try {
    window._setBtAudioDisconnected && window._setBtAudioDisconnected(false);
    console.log('[V173-BT] 蓝牙重新连接：清除断开标志，自动恢复播放');
    // 清除用户暂停态，允许自动恢复
    window._setUserPaused && window._setUserPaused(false);
    try { showToast('蓝牙已连接，恢复播放'); } catch(ign){}
    // 自动恢复播放当前电台（V173死循环已修复：内部resume走ACTION_META不广播，无回环）
    if (state.currentChannel && state.currentChannel.url) {
      try {
        if (hasNativeAudio() && state.playbackEngine === 'native') {
          var st = nativeAudioRpc('status');
          if (st && st.hasSource && !st.isPlaying) {
            console.log('[V173-BT] 蓝牙重连 → native resume');
            var resp = nativeAudioRpc('resume');
            state.isPlaying = resp ? !!resp.isPlaying : true;
            window._setUserPaused && window._setUserPaused(!state.isPlaying);
            if (state.isPlaying) setLastPlayPlaying(true);  // V183: 蓝牙重连恢复 → 播放意愿保持
            if (els.fpStatus) els.fpStatus.textContent = state.isPlaying ? '正在直播' : '已暂停';
            updatePlayerUI();
          } else if (st && !st.hasSource) {
            console.log('[V173-BT] 蓝牙重连 → 无源，playChannel 重载');
            if (els.fpStatus) els.fpStatus.textContent = '恢复播放中...';
            playChannel(state.currentChannel);
          } else {
            console.log('[V173-BT] 蓝牙重连 → 已在播放 isPlaying=' + (st && st.isPlaying));
            state.isPlaying = true;
            window._setUserPaused && window._setUserPaused(false);
            if (els.fpStatus) els.fpStatus.textContent = '正在直播';
            updatePlayerUI();
          }
        } else {
          console.log('[V173-BT] 蓝牙重连 → web 引擎，playChannel 重载');
          if (els.fpStatus) els.fpStatus.textContent = '恢复播放中...';
          playChannel(state.currentChannel);
        }
      } catch(e) { console.warn('[V173-BT] 恢复播放异常:', e); }
    } else {
      console.log('[V173-BT] 无当前电台，不自动恢复');
    }
  } catch(e) { console.error('[V173-BT] reconnect 处理异常:', e); }
};


/**
 * 渲染进程崩溃恢复检测（页面加载后调用）
 * 如果检测到崩溃标记，强制重新播放最后电台
 */
function checkRenderCrashRecovery() {
  try {
    if (!window.NativeRadio || !NativeRadio.wasRenderCrashed) return;
    const crashed = NativeRadio.wasRenderCrashed();
    if (!crashed) return;
    window.__RENDER_CRASH_RESUMING = true;  // V183: 告知冷启动续播让位，避免双重playChannel
    console.log('[RENDER-CRASH-RECOVER] 检测到渲染崩溃恢复，尝试重连播放');
    // 等待 init() 完成恢复 state.currentChannel 后再重连
    setTimeout(function() {
      try {
        const ch = state.currentChannel || window.__lastPlayChannel;
        if (ch && ch.url) {
          console.log('[RENDER-CRASH-RECOVER] 重连电台: ' + (ch.name || '?'));
          if (els.fpStatus) els.fpStatus.textContent = '恢复播放中...';
          playChannel(ch);
        }
      } catch(e) { console.warn('[RENDER-CRASH-RECOVER] 重连失败:', e); }
    }, 2000); // 延迟2秒等 init 完全完成
  } catch(e) { console.error('[RENDER-CRASH-RECOVER] 检测异常:', e); }
}

// V183: 冷启动自动续播。
//   背景：app被系统回收/force-stop/装更新后冷启动，旧代码只恢复电台选中态从不自动播放；
//   媒体键冷启动则由 Java Service 直接读持久化URL播放（见 RadioPlaybackService.coldStartPlayLastChannel）。
//   本函数处理"用户点开图标启动"路径，严格门控：
//     1) localStorage lastPlay.wasPlaying === true（播放/蓝牙断开保持，用户主动暂停/停止为false）
//     2) 当前存在外部音频输出（蓝牙耳机/有线/USB），手机扬声器状态绝不自动响
//   无外部输出但有播放意愿 → 调 armPendingBtRestore() 给Service布防，耳机后续连上即自动恢复。
function coldResumeIfNeeded() {
  if (!isNativeApp) { console.log('[V183-COLD] 非native环境，跳过冷启动续播'); return; }
  if (window.__COLD_RESUME_STARTED) return;
  window.__COLD_RESUME_STARTED = true;
  var lp = null;
  try { lp = loadLastPlay(); } catch(e) {}
  if (!lp || lp.wasPlaying !== true || !lp.url) {
    console.log('[V183-COLD] 无播放意愿/无URL，不自动续播 (wasPlaying=' + (lp ? lp.wasPlaying : 'no-lp') + ')');
    return;
  }
  console.log('[V183-COLD] 上次为播放中，等待native引擎就绪后检查外部音频输出...');
  var tries = 0;
  var tick = function() {
    tries++;
    try {
      if (window.__RENDER_CRASH_RESUMING) { console.log('[V183-COLD] 渲染崩溃恢复接管，冷启动续播让位'); return; }
      if (!window.__NATIVE_AUDIO_READY || !hasNativeAudio || !hasNativeAudio()) {
        if (tries < 30) { setTimeout(tick, 300); return; }
        console.log('[V183-COLD] native引擎久未就绪，放弃自动续播'); return;
      }
      // 1) 媒体键冷启动可能已被Service在Java层直起播放 → 仅同步UI，绝不重复playChannel
      var st = null;
      try { st = nativeAudioRpc('status'); } catch(e) {}
      if (st && st.isPlaying) {
        state.playbackEngine = 'native';
        state.isPlaying = true;
        window.__lastPlayChannel = state.currentChannel || window.__lastPlayChannel;
        if (els.fpStatus) els.fpStatus.textContent = '正在直播';
        try { updatePlayerUI(); } catch(ign){}
        console.log('[V183-COLD] Service已在播放(媒体键冷启动Java直连)，仅同步UI不重复播放');
        return;
      }
      // 2) 门控：必须有外部音频输出，杜绝扬声器自己响
      //    V183 FIX: 必须走nativeAudioRpc(shouldInterceptRequest通道)——ColorOS上
      //    addJavascriptInterface失效，window.NativeRadio=undefined，直接查永远false
      var hasOut = false;
      try {
        var hr = nativeAudioRpc('hasextaudio');
        hasOut = !!(hr && hr.ok && hr.has);
      } catch(e) {}
      if (!hasOut) {
        console.log('[V183-COLD] 无外部音频输出 → 不自动播放，向Service布防(耳机后续连上即恢复)');
        try { nativeAudioRpc('armbtrestore'); } catch(e) {}
        return;
      }
      // 3) 门控通过 → 自动续播上次电台
      var ch = state.currentChannel;
      if ((!ch || !ch.url) && lp.url) {
        ch = {
          id: lp.id, name: lp.name, url: lp.url,
          description: lp.description, category: lp.category,
          frequency: lp.frequency, color: lp.color,
          isUserStation: !!lp.isUserStation
        };
        state.currentChannel = ch;
      }
      if (ch && ch.url) {
        console.log('[V183-COLD] 外部输出在线 → 自动续播: ' + (ch.name || ch.id || '?'));
        if (els.fpStatus) els.fpStatus.textContent = '恢复播放中...';
        playChannel(ch);
      }
    } catch(e) { console.warn('[V183-COLD] tick异常:', e && e.message); }
  };
  setTimeout(tick, 1200);  // 等init渲染/数据加载/native注入
}

// V165: 云听等 radio.cn 时效签名URL检测 —— key&time 约24小时有效，过期后服务器403（无声）
function isSignedExpiringUrl(url) {
  try { return !!url && String(url).indexOf('radio.cn') >= 0 && String(url).indexOf('key=') >= 0 && String(url).indexOf('time=') >= 0; }
  catch(e) { return false; }
}
function signedUrlExpired(url) {
  try {
    const m = /[?&]time=([0-9a-fA-F]+)/.exec(String(url));
    if (!m) return false;
    const issuedAt = parseInt(m[1], 16) * 1000;
    if (!issuedAt) return false;
    return Date.now() - issuedAt > 25 * 3600 * 1000;  // 签发25小时后视为过期（保守值）
  } catch(e) { return false; }
}

// V165: 在内置频道里找同台稳定源 —— 去尾部「广播/电台」后前缀匹配（东莞交通广播↔东莞交通音乐广播）
function _coreStationName(s) {
  return String(s || '').replace(/[\s·]/g, '').replace(/(广播|电台)$/, '');
}
function findStableAlternative(ch) {
  try {
    const nm = _coreStationName(ch.name);
    if (nm.length < 3) return null;
    const pools = (state.channels.radio || []).concat(state.channels.tv || []);
    for (let i = 0; i < pools.length; i++) {
      const c = pools[i];
      if (!c || c.id === ch.id || !c.url || isSignedExpiringUrl(c.url)) continue;
      const cn = _coreStationName(c.name);
      if (cn.length < 3) continue;
      if (cn.indexOf(nm) === 0 || nm.indexOf(cn) === 0) return c;
    }
  } catch(e) {}
  return null;
}

function playChannel(ch) {
  if (!ch) return;
  // V165: 签名URL已过期 → 优先自动切换内置同名稳定源；无替代才提示更新链接。不打断当前播放。
  if (isSignedExpiringUrl(ch.url) && signedUrlExpired(ch.url)) {
    console.warn('[V165-SIGNED] 签名链接已过期(签发超25h): ' + (ch.name || ch.id));
    const _stable = ch._noSignFallback ? null : findStableAlternative(ch);
    if (_stable && _stable.url) {
      console.log('[V165-SIGNED] 自动切换稳定源: ' + _stable.name + ' (' + _stable.id + ') ' + String(_stable.url).substring(0, 60));
      showToast && showToast('「' + (ch.name || '') + '」云听链接已过期，已自动切换稳定源「' + _stable.name + '」');
      playChannel(Object.assign({}, _stable, { _noSignFallback: true }));
      return;
    }
    if (els.fpStatus) els.fpStatus.textContent = '云听链接已过期，请更新该电台链接';
    showToast && showToast('「' + (ch.name || '') + '」的云听链接已过期（约24小时有效），请更新链接或改用稳定源');
    return;
  }
  // ════════════════════════════════════════════════════════════════════
  // V169 FIX(第一次点击慢): 点击「当前已暂停的同一电台」→ 直接resume秒级出声。
  //   实测(logcat 12:25:59): 同台暂停后再点走了全量重载(重新拉HLS流) → 5.5秒才READY；
  //   而首次播放/正常换台只需0.7-1.1秒。resume路径与togglePlay一致，带hasSource检查防递归。
  // ════════════════════════════════════════════════════════════════════
  if (state.currentChannel && state.currentChannel.id === ch.id && !state.isPlaying &&
      state.playbackEngine === 'native' && hasNativeAudio()) {
    var _pausedSt = null;
    try { _pausedSt = nativeAudioRpc('status'); } catch (ign) {}
    if (_pausedSt && _pausedSt.hasSource) {
      try {
        nativeAudioRpc('resume');
        state.isPlaying = true;
        window._setUserPaused && window._setUserPaused(false);
        window._setBtAudioDisconnected && window._setBtAudioDisconnected(false);  // V171: 用户主动恢复，清除蓝牙断开标志
        setLastPlayPlaying(true);  // V183
        window.__lastPlayChannel = ch;
        if (els.fpStatus) els.fpStatus.textContent = '正在直播';
        updatePlayerUI();
        reportNativeState();
        console.log('[playChannel-V169] 同台已暂停 → RPC resume 秒级恢复(跳过全量重载)');
        return;
      } catch (eResume) {
        console.warn('[playChannel-V169] resume失败，回落全量播放: ' + (eResume && eResume.message || eResume));
      }
    }
  }
  // V159: 切换电台时清除用户暂停标志（新电台自动播放）
  window._setUserPaused && window._setUserPaused(false);
  window._setBtAudioDisconnected && window._setBtAudioDisconnected(false);  // V171: 用户主动播放，清除蓝牙断开标志
  // V152-RECONNECT: 记录正在播放的电台，供网络恢复/渲染崩溃后重连使用
  window.__lastPlayChannel = ch;
  console.log('[playChannel-V119] id=' + (ch.id||'?') + ' name=' + (ch.name||'').substring(0,24) + ' | url=' + (ch.url||'').substring(0,90));
  // 清理上一个引擎的资源（防止 web↔native 切换时双音轨）
  if (state.hls) { try { state.hls.destroy(); } catch(ign){} state.hls = null; }
  if (state.audioElement) { try { state.audioElement.pause(); } catch(ign){} try { state.audioElement.removeAttribute('src'); } catch(ign){} try { state.audioElement.load(); } catch(ign){} }
  state.currentChannel = ch;
  saveLastPlay(ch);
  if (els.fpStatus) els.fpStatus.textContent = '缓冲中...';
  updatePlayerUI();
  renderChannels();
  addToHistory(ch.id);
  // V118: 优先使用原生 ExoPlayer 引擎 — 通过 shouldInterceptRequest RPC 通道调用
  //       音频跑在系统 media cgroup，不受 ColorOS 锁屏 WebView 冻结影响
  //       NativeAudioPlayer.java 含 V108-VIDEO-AUDIO-ONLY 修复：禁用视频轨道，纯音频不需 Surface
  if (hasNativeAudio()) {
    state.playbackEngine = 'native';
    state.isPlaying = false;
    reportNativeState(true);
    try {
      var _sub = (ch.frequency || '') + (ch.description ? ' · ' + ch.description : '');
      var resp = nativeAudioRpc('play', { url: ch.url, name: ch.name || '', sub: _sub });
      state.isPlaying = resp ? !!resp.isPlaying : false;
      console.log('[playChannel-V121] → native ExoPlayer RPC isPlaying=' + state.isPlaying);
      updatePlayerUI();
      return;
    } catch(e) {
      console.warn('[playChannel-V121] native RPC 异常，回退 WebEngine:', e && e.message || e);
      state.playbackEngine = 'web';
    }
  }
  state.playbackEngine = 'web';
  playChannelWithWebEngine(ch);
}

// ========================================================================
//  V100 NATIVE EXOPLAYER EVENT HANDLER
//  window.addEventListener('nativeaudio', evt => evt.detail = {type, url, ...})
//  These are dispatched FROM Java NativeAudioPlayer.NativeAudioEvents cb via
//  wv.evaluateJavascript. They run on MAIN looper, so we can do minimal work.
// ========================================================================
function initNativeAudioListener_once() {
  if (initNativeAudioListener_once._done) return;
  initNativeAudioListener_once._done = true;
  window.addEventListener('nativeaudio', function onNativeAudio(evt) {
    const d = evt && evt.detail; if (!d) return;
    const tp = d.type || '';
    // V121: state.isPlaying 由同步 RPC 响应驱动，事件只更新状态文字
    if (state.playbackEngine !== 'native') return;
    switch (tp) {
      case 'isplaying':
        // 只更新状态文字，不改 state.isPlaying（RPC 已同步设置）
        if (els.fpStatus) els.fpStatus.textContent = (d.isPlaying ? '正在直播' : '缓冲中...');
        break;
      case 'state':
        if (d.state === 'BUFFERING') { if (els.fpStatus) els.fpStatus.textContent = '缓冲中...'; }
        else if (d.state === 'READY') { if (els.fpStatus) els.fpStatus.textContent = '正在直播'; }
        else if (d.state === 'ENDED') { if (els.fpStatus) els.fpStatus.textContent = '播放结束'; state.isPlaying = false; stopPlaying(); updatePlayerUI(); }
        break;
      case 'error':
        console.error('[NativeEngine] ERROR '+d.code+' '+d.name+': '+d.msg);
        // V184 关键修复: ExoPlayer IO类错误(1000~1099: 连接超时/网络断开/HTTP错误等,实测数据网
        //   蓝牙恢复后首包超时=1002)时, native V164已在Java层调度指数退避重试(8次)+V184 watchdog
        //   会兜底重建。旧代码无脑stop native并降级web引擎: stop把wantPlaying=false直接杀掉重试
        //   →永久无声(等用户拉前台); 且后台冻结时HTMLAudioElement根本不工作。网络错误只提示状态。
        var isIoErr = typeof d.code === 'number' && d.code >= 1000 && d.code < 1100;
        if (isIoErr) {
          if (els.fpStatus) els.fpStatus.textContent = '信号重连中…';
          state.isPlaying = true;  // 意愿仍在播放，等native自愈；UI播放态保持
          try { updatePlayerUI(); } catch(ign2){}
          console.warn('[NativeEngine-V184] IO error → native V164/watchdog handles retry, no stop, no web fallback');
          break;
        }
        if (els.fpStatus) els.fpStatus.textContent = '播放失败 (原生 '+d.name+')';
        const ch = state.currentChannel;
        if (ch && !onNativeAudio._fb) {
          onNativeAudio._fb = true;
          console.warn('[NativeEngine] native engine non-IO fatal — one-time soft fallback to Web engine');
          state.playbackEngine = 'web';
          try { nativeAudioRpc('stop'); } catch(ign){}
          playChannelWithWebEngine(ch);
        }
        updatePlayerUI();
        break;
      case 'play':
        if (els.fpStatus) els.fpStatus.textContent = '缓冲中...';
        break;
      case 'pause':
        if (els.fpStatus) els.fpStatus.textContent = '已暂停';
        break;
      case 'resume':
        if (els.fpStatus) els.fpStatus.textContent = '正在直播';
        break;
      case 'stop':
        state.isPlaying = false;
        if (els.fpStatus) els.fpStatus.textContent = '已停止';
        reportNativeState(); updatePlayerUI();
        break;
      case 'fatal':
        console.error('[NativeEngine] FATAL setup error -> web engine permanently', d.msg);
        const chF = state.currentChannel;
        state.playbackEngine = 'web';
        if (chF) playChannelWithWebEngine(chF);
        break;
    }
  });
  // Also: patch stopPlaying/pausePlaying/mini player so they call NativeAudio.stop/pause too
  const origStop = window.stopPlaying;
  window.stopPlaying = function patchedStop(opts) {
    // V167 FIX(致命死循环根因): 此包装器原来无视 fromNativeBroadcast 一律调 rpc stop：
    //   删除正在播的电台 → stop → Service广播STOP → JS广播handler再调stopPlaying → 又rpc stop
    //   → 无限循环(每15ms一轮 exo.stop+startFGS+stopSelf) → 点击新电台立即被循环杀掉(无声)
    //   → CPU空转被ColorOS杀应用("应用自己退出了")
    if (state.playbackEngine === 'native' && !(opts && opts.fromNativeBroadcast)) {
      try { nativeAudioRpc('stop'); } catch(ign){}
    }
    return origStop ? origStop.call(window, opts) : void 0;
  };
  // Pause button patches (fp-play, mini-play, etc.) are handled via DOM clicks.
  // For non-click pauses, expose helpers:
  window.__nativePause = function() {
    if (state.playbackEngine === 'native') try { nativeAudioRpc('pause'); } catch(ign){}
  };
  window.__nativeResume = function() {
    if (state.playbackEngine === 'native') try { nativeAudioRpc('resume'); } catch(ign){}
  };
  console.log('[NativeEngine] global listener installed');
}

function describeMediaError(err) {
  if (!err) return '';
  const m = {1:'MEDIA_ERR_ABORTED',2:'MEDIA_ERR_NETWORK',3:'MEDIA_ERR_DECODE',4:'MEDIA_ERR_SRC_NOT_SUPPORTED'};
  return (m[err.code] || ('code='+err.code)) + (err.message ? ' ' + err.message : '');
}

function playChannelWithWebEngine(ch) {
  if (!ch) return;
  setupAudio();
  if (state.hls) { try { state.hls.destroy(); } catch(ign){} state.hls = null; }
  const audio = state.audioElement;
  const isHls = /\.m3u8(\?|$)/i.test(ch.url);
  const chIdAtStart = ch.id;
  // ================================================================
  // V80: CAPACITOR androidScheme=http → NO Mixed Content AT ALL
  // ================================================================
  // Root cause of V77/V78/V79 pain was finally identified via
  // capacitor.config.json: Capacitor's DEFAULT androidScheme = "https",
  // making page origin = https://localhost — hence Chromium would
  // block any plain-HTTP radio stream URL as Mixed Content (both the
  // hls.js fetch/XHR layer for HLS AND the C++ media pipeline for
  // direct <audio src=http://...>). Electron does NOT have this issue
  // because mainWindow.loadFile() uses file:// origin + webSecurity:false
  // → effectively no CORS / Mixed Content enforcement.
  //
  // V80 FIX (matches Electron architecture by simplest possible means):
  //   capacitor.config.json -> { "server": { "androidScheme": "http",
  //                        "androidHostname": "localhost" } }
  // This makes WebView page origin = http://localhost, the SAME scheme
  // as every plain-HTTP radio stream. Mixed Content checking is defined
  // per Chromium spec as "request from secure context to non-secure
  // resource"; http://localhost is NOT a secure context that would
  // downgrade http subresources, so BOTH hls.js fetch() AND <audio>
  // media pipeline requests for http://radio URLs proceed normally,
  // exactly like in the browser / Electron. No local loopback proxy
  // is needed at all, removing IcyCleanProxy socket overhead / start
  // races.
  //
  // Historical note: The V79 local 127.0.0.1 loopback proxy was a
  // workaround built under the (now-proven-wrong) assumption that we
  // couldn't change Capacitor's page scheme away from https. With
  // androidScheme=http, the loopback proxy code is kept in MainActivity
  // for now as an unused fallback but the frontend no longer calls it.
  // HTTPS / data / blob / file URLs are untouched.
  let playbackUrl = ch.url;  // V80: NO wrapping ever — same scheme + origin
  console.log('[WebEngine] V80 direct-URL engine pick: scheme=' +
    ((playbackUrl||'').toLowerCase().split(':')[0]||'?') +
    ' isNative=' + !!isNativeApp +
    ' (page scheme=http per capacitor.config, so HTTP radio URLs are NOT Mixed Content)');

  // --- Audio event handlers are the SINGLE SOURCE OF TRUTH for state.isPlaying ---
  audio.onerror = () => {
    if (state.currentChannel && state.currentChannel.id !== chIdAtStart) return;
    const errDesc = describeMediaError(audio.error);
    console.error('[WebEngine] onerror ' + ch.name + ' url=' + ch.url + ' err=' + errDesc);
    // V82: 不再弹Toast，仅保留日志+状态栏文字
    // try { showToast('播放失败: ' + ch.name); } catch(ign){}
    if (els.fpStatus) els.fpStatus.textContent = '播放失败';
    state.isPlaying = false;
    updatePlayerUI();
    reportNativeState();
  };
  audio.onplaying = () => {
    if (state.currentChannel && state.currentChannel.id !== chIdAtStart) return;
    state.isPlaying = true;
    console.log('[WebEngine] onplaying: ' + ch.name);
    if (els.fpStatus) els.fpStatus.textContent = '正在直播';
    updatePlayerUI();
    reportNativeState();
  };
  audio.oncanplay = () => {
    if (state.currentChannel && state.currentChannel.id !== chIdAtStart) return;
    if (els.fpStatus && !state.isPlaying) els.fpStatus.textContent = '加载完成';
  };
  audio.onwaiting = () => {
    if (state.currentChannel && state.currentChannel.id !== chIdAtStart) return;
    if (els.fpStatus) els.fpStatus.textContent = '缓冲中...';
  };
  audio.onpause = () => {
    if (state.currentChannel && state.currentChannel.id !== chIdAtStart) return;
    state.isPlaying = false;
    updatePlayerUI();
    reportNativeState();
  };

  console.log('[WebEngine] load' + (isHls ? ' HLS' : '') + ': ' + ch.url);

  const retryPlayOnce = (reason, err) => {
    if (!state.currentChannel || state.currentChannel.id !== chIdAtStart) return;
    if (!state.audioElement) return;
    console.log('[WebEngine] retry play() once, reason=' + (reason||'?') + (err?' msg='+(err.message||err):''));
    setTimeout(() => {
      if (!state.currentChannel || state.currentChannel.id !== chIdAtStart || !state.audioElement) return;
      const p2 = state.audioElement.play();
      if (p2 && p2.catch) p2.catch(e2 => console.warn('[WebEngine] retry play() still rejected:', e2 && e2.message || e2));
    }, 250);
  };

  const isHttpsUrl = /^https:/i.test(ch.url);
  const hasHlsLib = typeof Hls !== 'undefined';
  const hlsSupported = hasHlsLib && Hls.isSupported();
  console.log('[WebEngine] decide engine: isHls='+isHls+' https='+isHttpsUrl+' nativeApp='+!!isNativeApp+
              ' Hls=' + (hasHlsLib ? ('v'+(Hls.version||'?')+' isSupported='+hlsSupported) : 'undefined(UNAVAILABLE)'));
  let engineTriedFallback = false;
  // v60: Relaxed engine selection
  //  - Non-HLS, or Hls library unavailable: go direct-native (single path).
  //  - Desktop + lib present: always prefer hls.js for browser compatibility.
  //  - Android (isNativeApp):
  //      HTTPS HLS => try HLS.JS FIRST as long as hls.js library IS LOADED,
  //                   regardless of Hls.isSupported()! Some Android WebView
  //                   builds misreport MSE support (e.g. OPPO ColorOS) so
  //                   they'd skip hls.js when they actually CAN run it just
  //                   fine (and that is exactly how Electron plays jjzs).
  //                   Fallback is immediate on any failure / 8s no onplaying.
  //      HTTP  HLS => Chromium native <audio src=m3u8> (hls.js XHR for TS
  //                   chunks gets Mixed Content blocked; MIXED_CONTENT_ALWAYS
  //                   _ALLOW only covers the <audio> media element itself).
  // V73: Android (isNativeApp) engine selection per-source-type:
  //  a) HTTPS HLS       -> always hls.js first (best, matches Electron)
  //  b) HTTP HLS        -> hls.js first too (Wowza 202.39.43.67:1935 returns ACAO=* so hls.js XHRs succeed directly)
  //                        MIXED_CONTENT_ALWAYS_ALLOW was already set on WebView settings, so HTTPS origin + HTTP media OK
  //  c) HTTP Icecast/Shoutcast (non-HLS audio/mp3/aac streams like FM99.1 at 125.227.87.206:8000) -> direct-native
  //                        These are not HLS; HTML5 <audio> natively supports them and will ignore any ICY metadata frame
  //  d) Non-native (desktop/Electron) => hls.js for all HLS, direct for rest (unchanged)
  const isIcecastNonHls = (!isHls) && /:8000\/|:8001\/|:8080\/|\/FM\d{2,3}\.\d?|shoutcast|icecast|icy-|listen\.lyapp/i.test(ch.url);
  let useHlsJs;
  if (isNativeApp) {
    useHlsJs = isHls && hasHlsLib;   // ALL HLS (both http + https) on Android try hls.js first now
  } else {
    useHlsJs = isHls && hasHlsLib;   // Desktop/Electron (same as before)
  }
  if (isIcecastNonHls) useHlsJs = false;  // Not HLS at all; skip hls.js for these always.

  // ---------- direct-native helper (also fallback path) ----------
  let directFirstAttempt = true;
  function playDirectNative(reason){
    if (engineTriedFallback && !directFirstAttempt) return;
    // prevent infinite loop: if this is the SECOND call with same engine AND same
    // reason from inside the play().catch below, we show toast.
    const isFallback = (typeof reason === 'string') && reason && reason.length && reason !== 'non-hls-direct';
    if (isFallback) engineTriedFallback = true;
    if (!state.currentChannel || state.currentChannel.id !== chIdAtStart) return;
    // destroy any hls state attached so far
    if (state.hls) { try { state.hls.destroy(); } catch(ign){} state.hls = null; }
    const why = (typeof reason === 'string') ? reason : 'fallback-direct';
    console.log('[WebEngine] engine=direct-native reason='+why+' url=' + (isHls ? '(HLS native)' : '(direct)') + ' ' + ch.url);
    // assign src, explicit audio.load() before play() is CRITICAL for some
    // Android WebView builds (OPPO ColorOS in particular) which would otherwise
    // reject play() immediately on HTTPS m3u8 urls with AbortError / NotSupportedError
    // before the media pipeline even had a chance to start.
    // V80: playbackUrl === ch.url (direct) because capacitor.config.json
    // now declares androidScheme=http → page origin http://localhost so
    // all http:// radio URLs are same-scheme, not Mixed Content.
    try {
      audio.removeAttribute('src');
    } catch(ign){}
    audio.src = playbackUrl;
    try {
      audio.load();
    } catch(ign){}
    function startPlay(isRetry){
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.then(() => console.log('[WebEngine] direct-native play() resolved'+(isRetry?' (retry)':'')+': ' + ch.name))
         .catch(e => {
            const msg = e && e.message ? e.message : String(e||'');
            console.warn('[WebEngine] direct-native play() '+(isRetry?'RETRY-':'')+'rejected:', msg || e);
            if (/interrupted|pause|domexception/i.test(msg)) {
              retryPlayOnce('direct-'+(isRetry?'retry':'')+'-interrupted-pause', e);
            } else if (!isRetry) {
              // FIRST attempt failed for another reason (likely immediate AbortError
              // on WebView HTTPS HLS or pending source not ready). Call audio.load()
              // a second time (forces re-resolution) and give play() another try.
              console.warn('[WebEngine] direct-native first play reject, retry load+play once');
              try { audio.load(); } catch(ign){}
              setTimeout(function(){
                if (!state.currentChannel || state.currentChannel.id !== chIdAtStart) return;
                startPlay(true);
              }, 350);
            } else {
              // SECOND attempt also failed -> now we finally report failure to user
              if (state.currentChannel && state.currentChannel.id === chIdAtStart) {
                // V82: 不再弹Toast，仅保留日志+状态栏文字
                // try { showToast('无法播放: ' + ch.name); } catch(ign){}
                if (els.fpStatus) els.fpStatus.textContent = '播放失败';
              }
            }
          });
      }
    }
    // Kick off first attempt. directFirstAttempt lets us distinguish an explicit
    // direct play request (first call to this helper for a channel) from a
    // fallback-here-via-hls.js-failure call; the retry above is gated by isRetry.
    directFirstAttempt = false;
    startPlay(false);
  }

  if (useHlsJs) {
    let hlsDeadlineTimer = null;
    let hlsDeadlineFired = false;
    // Clear any deadline once we are playing.
    const clearHlsDeadline = () => {
      if (hlsDeadlineTimer) { try { clearTimeout(hlsDeadlineTimer); } catch(_){} hlsDeadlineTimer = null; }
    };
    // If hls.js doesn't get us playing in 8 seconds, or fatal network error, bail to Chromium native.
    hlsDeadlineTimer = setTimeout(function(){
      hlsDeadlineFired = true;
      console.warn('[WebEngine] HLS(hls.js) no onplaying within 8s -> fallback to Chromium native');
      try { playDirectNative('hlsjs-8s-deadline'); } catch(_){}
    }, 8000);
    // Also cancel deadline on audio.onplaying FIRST (before our main state-setting handler runs)
    audio.addEventListener('playing', function oncePlaying(){
      audio.removeEventListener('playing', oncePlaying, true);
      clearHlsDeadline();
    }, true);
    try {
      // V68: 100% Electron版hls配置，关键是fetchSetup(no-cors/credentials)，因为Electron经济之声经典音乐广播都是这么配的能正常播放
      state.hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 60,
        maxMaxBufferLength: 120,
        maxBufferSize: 60 * 1000 * 1000,
        maxBufferHole: 0.5,
        startLevel: -1,
        fetchSetup: {
          mode: 'no-cors',
          credentials: 'include'
        }
      });
      // Verbose event logging (helps figure out why 经济之声 fails)
      const EV = Hls.Events || {};
      [EV.MANIFEST_PARSED, EV.LEVEL_PTS_UPDATED, EV.LEVEL_LOADED, EV.FRAG_LOADED, EV.FRAG_BUFFERED, EV.ERROR]
        .forEach(function(ev){ if (!ev) return; state.hls.on(ev, function(name, data){
          if (ev === EV.ERROR) {
            console.warn('[WebEngine] HLS(hls.js) ERROR type=' + (data&&data.type) + ' details=' + (data&&data.details) +
                         ' fatal=' + (data&&data.fatal) + ' response.code=' + ((data&&data.response&&data.response.code)||'?'));
            // Fatal network/media errors -> immediate fallback to Chromium native
            if (data && data.fatal && !hlsDeadlineFired) {
              clearHlsDeadline();
              console.warn('[WebEngine] HLS(hls.js) FATAL -> fallback now');
              try { playDirectNative('hlsjs-fatal-' + (data.details||'')); } catch(_){}
            }
          } else {
            // non-error events -> concise info only
            const extra = (ev === EV.MANIFEST_PARSED)
              ? (' levels=' + ((data&&data.levels&&data.levels.length)||0) + ' audioTracks=' + ((data&&data.audioTracks&&data.audioTracks.length)||0))
              : ((ev === EV.LEVEL_LOADED)
                  ? (' bitrate=' + ((data&&data.level&&data.level.bitrate)||'?') + ' url=' + String((data&&data.level&&data.level.url)||'').substr(0,80))
                  : (''));
            console.log('[WebEngine] HLS(hls.js) ' + String(ev).substr(0,28) + extra);
          }
        }.bind(null, ev)); });
      // V80: hls.js fetches http URLs from page origin http://localhost.
      // Same-scheme = NO Mixed Content blocking = direct fetch works, just
      // like the Electron desktop build (which uses file:// + webSecurity:false
      // and also passes URLs straight into Hls.loadSource() with no wrapping).
      state.hls.loadSource(playbackUrl);
      state.hls.attachMedia(audio);
      // V82: 原始0秒立即播放！attachMedia之后立即play()，不等任何事件！
      console.log('[WebEngine-V82] HLS(hls.js) load+attach done → 立即audio.play() (0秒无延迟)');
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.then(function(){ console.log('[WebEngine] HLS(hls.js) play() resolved: ' + ch.name); })
         .catch(function(e){
            const msg = e && e.message ? e.message : '';
            console.warn('[WebEngine] HLS(hls.js) play() rejected:', msg || e);
            if (/interrupted|pause|domexception/i.test(msg)) {
              retryPlayOnce('hlsjs-interrupted-domexception', e);
            } else if (!hlsDeadlineFired) {
              // Something else went wrong starting play -> fallback to native
              console.warn('[WebEngine] HLS(hls.js) play() hard reject -> fallback');
              clearHlsDeadline();
              try { playDirectNative('hlsjs-play-reject'); } catch(_){}
            }
          });
      }
    } catch (hlsInitErr) {
      // Hls constructor / on / loadSource threw synchronously. Fallback immediately.
      console.error('[WebEngine] HLS(hls.js) init exception -> fallback:', hlsInitErr && hlsInitErr.message || hlsInitErr);
      clearHlsDeadline();
      try { playDirectNative('hlsjs-init-exception'); } catch(_){}
    }
  } else {
    playDirectNative(useHlsJs===false ? (isHls ? 'http-hls-no-hlsjs' : 'non-hls-direct') : 'no-hlsjs');
  }
  // STATELESS LAUNCH: intentionally NO state.isPlaying=true here.
  // Chromium audio.onplaying is the sole source of truth (matches Electron/browser).
  if (!isNativeApp && !ch.logo) fetchAndUpdateLogo(ch);
}

function setupAudio() {
  if (state.audioElement) return;
  state.audioElement = new Audio();
  // v56: do NOT set crossOrigin='anonymous'. HTTP MP3 / HLS ICY streams
  // (e.g. 大千电台 http://125.227.87.206:8000/FM99.1, 光华之声 HTTP m3u8)
  // are served without CORS headers, so an 'anonymous' crossorigin forces
  // a CORS preflight that fails and triggers MEDIA_ERR_SRC_NOT_SUPPORTED.
  // Electron and direct browser playback do not add crossorigin either.
  state.audioElement.volume = 0.8;
  state.audioElement.preload = 'auto';
}

function togglePlay() {
  if (!state.currentChannel) {
    const chs = getFilteredChannels();
    if (chs.length) playChannel(chs[0]);
    return;
  }
  // V138: 先判断"播放引擎是否真的加载了currentChannel"
  //   - 启动刚恢复 lastPlay 时，state.playbackEngine 默认是'web'，但 native audio 有更高优先级
  //   - 如果 hasnativeAudio()，优先调 native 的 status.hasSource 看是否有加载
  //   - 如果没加载（不管当前 engine 是 web 还是 native），直接 playChannel(currentChannel) 重新加载 URL
  //   - 这样 playChannel 自己会选择正确引擎（native>web），避免"按播放按钮没声音"
  var chForReload = state.currentChannel;
  var needFreshPlay = false;
  var nativeStatusResp = null;
  if (hasNativeAudio()) {
    try {
      nativeStatusResp = nativeAudioRpc('status');
      if (!nativeStatusResp || !nativeStatusResp.hasSource) { needFreshPlay = true; }
      console.log('[togglePlay-V138] native status check: ' + JSON.stringify(nativeStatusResp||{}) + ' needFreshPlay=' + needFreshPlay);
    } catch (eStatus) {
      console.log('[togglePlay-V138] native status ex → assume needFreshPlay: ' + (eStatus && eStatus.message));
      needFreshPlay = true;
    }
  } else {
    // Web 引擎：检查 audioElement.src 是否等于 currentChannel.url
    var webHasSrc = state.audioElement && state.audioElement.src &&
                    state.audioElement.src === chForReload.url;
    if (!webHasSrc) needFreshPlay = true;
    console.log('[togglePlay-V138] web audio check: src=' + (state.audioElement ? state.audioElement.src : 'null') + ' needFreshPlay=' + needFreshPlay);
  }
  if (needFreshPlay) {
    playChannel(chForReload);
    return;
  }

  // 走到这里：引擎已经有播放源，只要暂停/恢复即可
  console.log('[togglePlay] state.isPlaying=' + state.isPlaying + ' engine=' + state.playbackEngine + ' hasNativeAudio=' + hasNativeAudio());
  var wasPlaying = state.isPlaying;
  if (state.playbackEngine === 'native' && hasNativeAudio()) {
    try {
      var resp;
      if (state.isPlaying) {
        resp = nativeAudioRpc('pause');
        state.isPlaying = false;
        window._setUserPaused && window._setUserPaused(true);  // V159: 标记用户主动暂停
        setLastPlayPlaying(false);  // V183: 用户手动暂停 → 不自动续播
        console.log('[togglePlay-V123] pause RPC done -> isPlaying=false');
      } else {
        resp = nativeAudioRpc('resume');
        state.isPlaying = true;
        window._setUserPaused && window._setUserPaused(false);  // V159: 清除暂停标志
        window._setBtAudioDisconnected && window._setBtAudioDisconnected(false);  // V171: 用户主动恢复，清除蓝牙断开标志
        setLastPlayPlaying(true);  // V183: 用户手动恢复播放
        console.log('[togglePlay-V123] resume RPC done -> isPlaying=true (resp=' + JSON.stringify(resp) + ')');
      }
      if (els.fpStatus) {
        if (state.isPlaying) els.fpStatus.textContent = '正在直播';
        else els.fpStatus.textContent = '已暂停';
      }
      updatePlayerUI();
      reportNativeState();
      return;
    } catch (e) {
      console.warn('[NativeEngine] togglePlay via RPC failed, fallback:', e && e.message || e);
      state.isPlaying = !wasPlaying;
      if (els.fpStatus) {
        if (state.isPlaying) els.fpStatus.textContent = '正在直播';
        else els.fpStatus.textContent = '已暂停';
      }
      updatePlayerUI();
    }
  }
  if (state.playbackEngine === 'native' && hasNative() && typeof window.NativeRadio.togglePlayNative === 'function') {
    try {
      window.NativeRadio.togglePlayNative();
      state.isPlaying = !state.isPlaying;
      if (els.fpStatus) {
        if (state.isPlaying) els.fpStatus.textContent = '正在直播';
        else els.fpStatus.textContent = '已暂停';
      }
      updatePlayerUI();
      reportNativeState();
      return;
    } catch (e) { console.warn('togglePlayNative failed', e); }
  }
  if (state.isPlaying) {
    if (state.audioElement) state.audioElement.pause();
    state.isPlaying = false;
  } else {
    if (state.audioElement) state.audioElement.play().catch(()=>{});
    state.isPlaying = true;
  }
  if (els.fpStatus) {
    if (state.isPlaying) els.fpStatus.textContent = '正在直播';
    else els.fpStatus.textContent = '已暂停';
  }
  updatePlayerUI();
  reportNativeState();
}
function prevChannel() {
  const chs = getFilteredChannels(); if (!chs.length) return;
  let i = chs.findIndex(c => c.id === state.currentChannel?.id);
  i = i > 0 ? i-1 : chs.length-1; playChannel(chs[i]);
}
function nextChannel() {
  const chs = getFilteredChannels(); if (!chs.length) return;
  let i = chs.findIndex(c => c.id === state.currentChannel?.id);
  i = (i+1) % chs.length; playChannel(chs[i]);
}

/* ============ UI UPDATE ============ */
function formatTimeHMSS(d) {
  if (!d) d = new Date();
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  const ss = String(d.getSeconds()).padStart(2,'0');
  return `${hh}:${mm}:${ss}`;
}

let miniProgressStartSec = 0;
function startMiniProgressTicker() {
  const tick = () => {
    // V159 POWER: 非播放 且 无定时关闭 → 不用重绘mini进度条（省DOM写入+计算）
    if (!state.isPlaying && !state.timerEnd) return;
    const now = new Date();
    const nowSec = now.getHours()*3600 + now.getMinutes()*60 + now.getSeconds();
    if (els.miniTimeStart) els.miniTimeStart.textContent = formatTimeHMSS(now);
    if (els.miniTimeEnd) {
      // 定时结束时间 or 默认+1小时
      const endSec = state.timerEnd > 0
        ? Math.floor(state.timerEnd / 1000) % 86400
        : (nowSec + 3600) % 86400;
      const eh = Math.floor(endSec/3600), em = Math.floor((endSec%3600)/60), es = endSec%60;
      els.miniTimeEnd.textContent = `${String(eh).padStart(2,'0')}:${String(em).padStart(2,'0')}:${String(es).padStart(2,'0')}`;
    }
    if (els.miniProgressFill) {
      // 相对进度：以 1 小时刻度作为满进度（视觉用，非真实可seek）
      let cycleStart = miniProgressStartSec;
      let cur = nowSec - cycleStart;
      if (cur < 0) cur += 86400;
      const cycle = 3600;
      const pct = (cur % cycle) / cycle * 100;
      els.miniProgressFill.style.width = pct + '%';
      if (els.miniProgressThumb) {
        els.miniProgressThumb.style.display = 'block';
        els.miniProgressThumb.style.left = pct + '%';
      }
    }
  };
  tick();
  // V164 POWER: 锁屏/后台时停掉每秒进度条定时器（纯视觉元素，后台刷新无人看见且白耗电）。
  //   回前台时立即tick()校准（基于当前时间计算，无漂移）并重启。
  let _miniTimer = setInterval(tick, 1000);
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      if (_miniTimer) { clearInterval(_miniTimer); _miniTimer = null; }
    } else {
      if (!_miniTimer) _miniTimer = setInterval(tick, 1000);
      tick();
    }
  });
}

function updatePlayerUI() {
  const ch = state.currentChannel;
  const playIcon = state.isPlaying
    ? '<svg id="miniPlayIcon" viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z"/></svg>'
    : '<svg id="miniPlayIcon" viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M7 5v14l11-7z"/></svg>';
  const fpPlayIcon = state.isPlaying
    ? '<svg id="fpPlayIcon" viewBox="0 0 24 24" width="38" height="38" fill="currentColor"><path d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z"/></svg>'
    : '<svg id="fpPlayIcon" viewBox="0 0 24 24" width="38" height="38" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

  if (ch) {
    const sub = ch.category ? ch.category : ((ch.frequency ? ch.frequency : '') + (ch.description ? ' · ' + ch.description : ''));
    els.miniName.textContent = ch.name || '未选择';
    els.miniSub.textContent = sub || '正在直播';
    els.fpName.textContent = ch.name || '未选择';
    els.fpSub.textContent = (ch.frequency ? ch.frequency + '  ·  ' : '') + (ch.description || '');
    els.fpLogoInner.innerHTML = ch.logo
      ? `<img src="${ch.logo}" alt="" onerror="this.onerror=null;this.outerHTML='<span style=&quot;font-size:80px&quot;>📻</span>'"/>`
      : `<span style="font-size:80px">📻</span>`;
    els.fpBg.style.backgroundImage = ch.logo ? `url("${ch.logo}")` : `linear-gradient(135deg, ${ch.color||'#e63946'}, #111)`;
    const isFav = state.favorites.includes(ch.id);
    els.fpFav.classList.toggle('active', isFav);
    if (els.miniFav) els.miniFav.classList.toggle('active', isFav);
    if (els.miniLine) {
      const urls = [ch.url].flat();
      els.miniLine.textContent = urls.length > 1 ? '线路2' : '线路1';
    }
  } else {
    els.miniName.textContent = '选择一个电台';
    els.miniSub.textContent = '点击任意电台开始收听';
    if (els.miniLine) els.miniLine.textContent = '线路1';
    els.fpName.textContent = '未选择电台';
    els.fpSub.textContent = '--';
    els.fpLogoInner.innerHTML = '<span style="font-size:80px">📻</span>';
    els.fpBg.style.backgroundImage = '';
  }
  els.miniPlay.innerHTML = playIcon;
  els.fpPlay.innerHTML = fpPlayIcon;
  // 给按钮加 playing / paused 状态，CSS 根据状态调整 SVG 位移：
  //   播放时 = || 两个矩形 → 需要严格几何居中（translateX 0）
  //   暂停时 = ▶ 三角形 → 需要轻微 translateX(+6%) 视觉居中（因为三角形左边是尖的）
  els.miniPlay.classList.toggle('playing', state.isPlaying);
  els.miniPlay.classList.toggle('paused',  !state.isPlaying);
  els.fpPlay.classList.toggle('playing', state.isPlaying);
  els.fpPlay.classList.toggle('paused',  !state.isPlaying);
  els.fullPlayer.classList.toggle('playing', state.isPlaying);
  // V159 POWER: 播放/暂停切换 → 立刻同步CSS动画状态（暂停时关闭脉冲/封面旋转省电）
  try { window._applyAnimationsState && window._applyAnimationsState(); } catch(e) {}
}

/* ============ EVENTS ============ */
function setupEventListeners() {
  // Search & Timer top icons
  els.searchBtn.addEventListener('click', openSearch);
  if (els.timerTopBtn) els.timerTopBtn.addEventListener('click', openTimer);
  if (els.miniTimerBtn) els.miniTimerBtn.addEventListener('click', openTimer);

  els.searchClose.addEventListener('click', closeSearch);
  els.searchClear.addEventListener('click', () => {
    els.searchInput.value = ''; state.searchQuery = '';
    els.searchClear.style.display='none'; doSearch();
  });
  els.searchInput.addEventListener('input', e => {
    state.searchQuery = e.target.value;
    els.searchClear.style.display = state.searchQuery ? 'flex' : 'none';
    doSearch();
  });
  // V150: 搜索历史清空按钮
  if (els.searchHistoryClear) {
    els.searchHistoryClear.addEventListener('click', () => {
      clearSearchHistory();
      renderSearchHistory();
    });
  }

  // Mini player
  els.miniLeft.addEventListener('click', openFullPlayer);
  els.miniPlay.addEventListener('click', e => { e.stopPropagation(); togglePlay(); });
  els.miniPrev.addEventListener('click', e => { e.stopPropagation(); prevChannel(); });
  els.miniNext.addEventListener('click', e => { e.stopPropagation(); nextChannel(); });
  if (els.miniFav) els.miniFav.addEventListener('click', e => {
    e.stopPropagation();
    if (state.currentChannel) toggleFavorite(state.currentChannel.id);
  });

  // Bottom Tabs (首页/搜索/我的)
  if (els.bottomTabs) {
    els.bottomTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const name = tab.dataset.tab;
        els.bottomTabs.forEach(t => t.classList.toggle('active', t === tab));
        if (name === 'home') {
          state.currentFilter = '全部';
          state.searchQuery = '';
          renderCategories();
          renderChannels();
          updateTopRegion();
        } else if (name === 'search') {
          openSearch();
        } else if (name === 'mine') {
          openManage();
        }
      });
    });
  }

  // Full player
  els.fpClose.addEventListener('click', closeFullPlayer);
  els.fpPlay.addEventListener('click', togglePlay);
  els.fpPrev.addEventListener('click', prevChannel);
  els.fpNext.addEventListener('click', nextChannel);
  els.fpFav.addEventListener('click', () => { if (state.currentChannel) toggleFavorite(state.currentChannel.id); });
  els.fpTimer.addEventListener('click', openTimer);
  els.fpVolume.addEventListener('input', e => { const v = +e.target.value/100; if(state.audioElement) state.audioElement.volume = v; });
  if (els.fpMenu) els.fpMenu.addEventListener('click', openManage);

  // Sheets
  els.sheetClose.addEventListener('click', () => els.modalSheet.classList.remove('show'));
  els.editSheetClose.addEventListener('click', () => els.editSheet.classList.remove('show'));
  els.editCancel.addEventListener('click', () => els.editSheet.classList.remove('show'));
  els.timerSheetClose.addEventListener('click', () => els.timerSheet.classList.remove('show'));
  document.querySelectorAll('.modal-sheet, .search-sheet').forEach(s => {
    s.addEventListener('click', e => { if (e.target === s) s.classList.remove('show'); });
  });

  // Manage
  els.addChannelBtn.addEventListener('click', openAddChannel);
  els.exportBtn.addEventListener('click', exportChannels);
  // V156: 导入/恢复 改用 SAF → 点击按钮后调 fetch RPC 启动 Android 原生 ACTION_OPEN_DOCUMENT
  //       彻底解决 ColorOS WebView 上 <input type=file> / label覆盖 点击无反应问题
  els.importBtn.addEventListener('click', safImportChannels);
  els.resetBtn.addEventListener('click', resetChannels);
  // V143: 用户数据备份/恢复
  if (els.backupBtn) els.backupBtn.onclick = backupUserData;
  if (els.restoreBtn) els.restoreBtn.onclick = safRestoreUserData;
  // 事件委托：在 document 上捕获 click，确保即使 onclick 失效也能触发
  document.addEventListener('click', function(e) {
    var btn = e.target.closest ? e.target.closest('#backupBtn') : (e.target.id === 'backupBtn' ? e.target : null);
    if (btn) {
      if (typeof btn.onclick !== 'function') {
        e.preventDefault();
        e.stopPropagation();
        backupUserData();
      }
    }
    var btnR = e.target.closest ? e.target.closest('#restoreBtn') : (e.target.id === 'restoreBtn' ? e.target : null);
    if (btnR) {
      if (typeof btnR.onclick !== 'function') {
        e.preventDefault();
        e.stopPropagation();
        safRestoreUserData();
      }
    }
  }, true); // 捕获阶段
  els.fetchLogoBtn && els.fetchLogoBtn.addEventListener('click', startBatchFetch);
  els.editForm.addEventListener('submit', submitEditForm);

  // Personal (V126)
  if (els.personalSheetClose) els.personalSheetClose.addEventListener('click', () => els.personalSheet.classList.remove('show'));
  if (els.personalCancel) els.personalCancel.addEventListener('click', () => els.personalSheet.classList.remove('show'));
  if (els.personalForm) els.personalForm.addEventListener('submit', submitPersonalForm);
  if (els.personalBatchFile) els.personalBatchFile.addEventListener('change', handlePersonalBatchFile);

  // Batch import sheet (V129)
  if (els.batchSheetClose) els.batchSheetClose.addEventListener('click', closeBatchSheet);
  if (els.batchCancel) els.batchCancel.addEventListener('click', closeBatchSheet);
  if (els.batchCopyTemplate) els.batchCopyTemplate.addEventListener('click', copyTemplateToClipboard);
  if (els.batchClear) els.batchClear.addEventListener('click', () => { if (els.batchTextarea) els.batchTextarea.value = ''; });
  if (els.batchImport) els.batchImport.addEventListener('click', () => {
    if (els.batchTextarea) parseAndImportText(els.batchTextarea.value);
  });
  // Close sheet on overlay click
  els.batchSheet && els.batchSheet.addEventListener('click', e => {
    if (e.target === els.batchSheet) closeBatchSheet();
  });

  // Timer chips
  document.querySelectorAll('.timer-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const min = +btn.dataset.time;
      document.querySelectorAll('.timer-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      setTimer(min);
    });
  });
}

/**
 * 初始化主题：
 *   - localStorage.radio_theme_pref = 'auto'(默认) / 'light' / 'dark'
 *   auto 时，完全交给 prefers-color-scheme，<html> 不设 data-theme
 *   强制时，<html data-theme="..."> 覆盖 media query
 */
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
  applyTheme(saved || 'auto');

  // 当选择 auto 且系统主题变化时，meta.theme-color 需要随系统变（只响应一次）
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      const cur = (() => { try { return localStorage.getItem(THEME_KEY); } catch (e) { return 'auto'; } })() || 'auto';
      if (cur === 'auto') applyTheme('auto');
    });
  } catch (e) {}
  // 应用到按钮高亮
  updateThemeButtons(saved || 'auto');
}

function applyTheme(pref) {
  const root = document.documentElement;
  if (pref === 'auto') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', pref);
  }
  try {
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      const isLightNow = (pref === 'light') || (pref === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
      metaTheme.setAttribute('content', isLightNow ? '#f2f2f7' : '#000000');
    }
  } catch (e) {}
}

function setupThemeSwitcher() {
  const btns = els.themeBtns;
  if (!btns || !btns.length) return;
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const pref = btn.dataset.theme || 'auto';
      try { localStorage.setItem(THEME_KEY, pref); } catch (e) {}
      applyTheme(pref);
      updateThemeButtons(pref);
    });
  });
}

function updateThemeButtons(pref) {
  const btns = document.querySelectorAll('.theme-btn');
  if (!btns) return;
  btns.forEach(b => {
    const on = (b.dataset.theme === pref);
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

/* ============ 字体切换 ============ */
function initFont() {
  let saved = null;
  try { saved = localStorage.getItem(FONT_KEY); } catch (e) {}
  applyFont(saved || 'system');
  updateFontButtons(saved || 'system');
}
function applyFont(pref) {
  const root = document.documentElement;
  if (!pref || pref === 'system') root.removeAttribute('data-font');
  else root.setAttribute('data-font', pref);
}
function setupFontSwitcher() {
  const btns = els.fontBtns;
  if (!btns || !btns.length) return;
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const pref = btn.dataset.font || 'system';
      try { localStorage.setItem(FONT_KEY, pref); } catch (e) {}
      applyFont(pref);
      updateFontButtons(pref);
    });
  });
}
function updateFontButtons(pref) {
  const btns = document.querySelectorAll('.font-btn');
  if (!btns) return;
  btns.forEach(b => {
    const on = (b.dataset.font === pref);
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

/* ============ 定位 + 逆地理匹配左侧省市 ============ */
// 把逆地理返回的省名 → 左侧分类的 key
const PROVINCE_ALIASES = {
  '北京市':'北京','上海市':'上海','天津市':'天津','重庆市':'重庆',
  '河北省':'河北','山西省':'山西','辽宁省':'辽宁','吉林省':'吉林','黑龙江省':'黑龙江',
  '江苏省':'江苏','浙江省':'浙江','安徽省':'安徽','福建省':'福建','江西省':'江西','山东省':'山东',
  '河南省':'河南','湖北省':'湖北','湖南省':'湖南','广东省':'广东','广西壮族自治区':'广西','海南省':'海南',
  '四川省':'四川','贵州省':'贵州','云南省':'云南','西藏自治区':'西藏',
  '陕西省':'陕西','甘肃省':'甘肃','青海省':'青海','宁夏回族自治区':'宁夏','新疆维吾尔自治区':'新疆',
  '内蒙古自治区':'内蒙古',
  '香港特别行政区':'香港','澳门特别行政区':'澳门','台湾省':'台湾',
  '广西':'广西','宁夏':'宁夏','新疆':'新疆','西藏':'西藏','内蒙古':'内蒙古','香港':'香港','澳门':'澳门','台湾':'台湾'
};

// 把各种形式的省名（广东/广东省/Guangdong/深圳所在的省名）转成左侧分类的合法 key
// 如果都找不到，返回原始字符串（getCategoryList 会自动发现 list.indexOf===-1 就跳过置顶，不影响其他逻辑）
function normalizeProvinceKey(rawName) {
  if (!rawName) return '';
  var s = String(rawName).trim();
  if (!s) return '';
  // 1) 直接命中（包含别名的 key 或 value）
  if (PROVINCE_ALIASES[s]) return PROVINCE_ALIASES[s];
  // 2) 直接命中（value 本身）
  var vs = Object.values(PROVINCE_ALIASES);
  if (vs.indexOf(s) >= 0) return s;
  // 3) 去掉后缀再试（省/市/自治区/维吾尔/壮族/回族/特别行政区）
  var cleaned = s
    .replace(/特别行政区$/g, '').replace(/自治区$/g, '').replace(/省$/g, '').replace(/市$/g, '')
    .replace(/维吾尔$/g, '').replace(/壮族$/g, '').replace(/回族$/g, '');
  if (PROVINCE_ALIASES[cleaned]) return PROVINCE_ALIASES[cleaned];
  if (vs.indexOf(cleaned) >= 0) return cleaned;
  // 4) 模糊包含（2 字合法 key 出现在 s 里，或 s 里出现在 2 字 key）
  for (var i = 0; i < vs.length; i++) {
    var k = vs[i];
    if (!k || k.length < 2) continue;
    if (s.indexOf(k) >= 0) return k;
    if (k.indexOf(cleaned) >= 0 && cleaned.length >= 2) return k;
  }
  // 5) 英文兜底：常见英文省名映射
  var EN_MAP = {
    'Beijing':'北京','Shanghai':'上海','Tianjin':'天津','Chongqing':'重庆',
    'Hebei':'河北','Shanxi':'山西','Liaoning':'辽宁','Jilin':'吉林','Heilongjiang':'黑龙江',
    'Jiangsu':'江苏','Zhejiang':'浙江','Anhui':'安徽','Fujian':'福建','Jiangxi':'江西','Shandong':'山东',
    'Henan':'河南','Hubei':'湖北','Hunan':'湖南','Guangdong':'广东','Guangxi':'广西','Hainan':'海南',
    'Sichuan':'四川','Guizhou':'贵州','Yunnan':'云南','Tibet':'西藏',
    'Shaanxi':'陕西','Gansu':'甘肃','Qinghai':'青海','Ningxia':'宁夏','Xinjiang':'新疆',
    'Inner Mongolia':'内蒙古','Nei Mongol':'内蒙古',
    'Hong Kong':'香港','Macau':'澳门','Macao':'澳门','Taiwan':'台湾'
  };
  if (EN_MAP[s]) return EN_MAP[s];
  // 大小写不敏感再扫一轮
  var sLow = s.toLowerCase();
  var keys = Object.keys(EN_MAP);
  for (var j = 0; j < keys.length; j++) {
    if (sLow === keys[j].toLowerCase() || sLow.indexOf(keys[j].toLowerCase()) >= 0) {
      return EN_MAP[keys[j]];
    }
  }
  return s;
}

function applyLocatedProvince(provinceName) {
  if (!provinceName) return false;
  const key = PROVINCE_ALIASES[provinceName] || provinceName;
  const cats = getCategoryList();
  if (cats.indexOf(key) >= 0) {
    state.currentFilter = key;
    state.searchQuery = '';
    renderCategories();
    renderChannels();
    updateTopRegion();
    return true;
  }
  // 再试试模糊匹配（key 出现在 provinceName 里，或者反过来）
  const fuzzy = cats.find(c =>
    (provinceName.indexOf(c) >= 0) ||
    (c.length >= 2 && provinceName.indexOf(c.slice(0, 2)) >= 0) ||
    (PROVINCE_ALIASES[c] && provinceName.indexOf(PROVINCE_ALIASES[c]) >= 0)
  );
  if (fuzzy) {
    state.currentFilter = fuzzy;
    state.searchQuery = '';
    renderCategories();
    renderChannels();
    updateTopRegion();
    return true;
  }
  return false;
}

// 通用 XHR Promise 封装（带状态诊断：status/statusText/preview）
function xhrGet(url, timeoutMs) {
  return new Promise(function (resolve) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.timeout = timeoutMs || 8000;
      xhr.open('GET', url, true);
      xhr.onload = function () {
        var text = (xhr.responseText == null) ? '' : String(xhr.responseText);
        resolve({
          ok: (xhr.status >= 200 && xhr.status < 300),
          status: xhr.status || 0,
          statusText: xhr.statusText || '',
          text: text,
          preview: text.slice(0, 180).replace(/\s+/g, ' '),
        });
      };
      xhr.onerror = function () { resolve({ ok: false, status: xhr.status || 0, statusText: 'NETWORK_ERR', text: '', preview: 'onerror fired' }); };
      xhr.ontimeout = function () { resolve({ ok: false, status: xhr.status || 0, statusText: 'TIMEOUT', text: '', preview: 'timeout' }); };
      xhr.send(null);
    } catch (e) { resolve({ ok: false, status: -1, statusText: 'XHR_EXCEPTION', text: '', preview: (e && e.message) ? String(e.message) : 'unknown xhr ex' }); }
  });
}

// 逆地理：四道兜底（高德 → OSM → ip-api.com → ipwho.is），任何一道拿到省就算成功
//   V137: 放弃需要 key 的 QQIP，改用 ip-api.com（国内免费稳定、无需key、对深圳/广州等
//         运营商IP归属地判断比 ipwho.is 准确得多）作为 IP 第1优先；ipwho.is 最后兜底
async function reverseGeocode(lat, lng) {
  var prov = '';
  var city = '';
  var district = '';
  var diags = [];

  // --- 第 1 道：高德逆地理（CN 专用，速度快）
  try {
    var amapKey = '6a511d2ad2e6cd9ba779fdc5d114ea0f';
    var amapUrl = 'https://restapi.amap.com/v3/geocode/regeo?key=' + amapKey +
                  '&location=' + encodeURIComponent(lng + ',' + lat) +
                  '&extensions=base&radius=1000&output=json';
    var a = await xhrGet(amapUrl, 6000);
    var ok1 = false;
    if (a.ok && a.text) {
      try {
        var j = JSON.parse(a.text);
        var ac = (j && j.regeocode && j.regeocode.addressComponent) || {};
        prov = String(ac.province || '').trim();
        city = String(ac.city || '').trim();
        district = String(ac.district || '').trim();
        if (prov) ok1 = true;
      } catch (e) { diags.push('AMAP parse: ' + (e && e.message ? e.message : 'parse err')); }
    }
    if (!ok1) diags.push('AMAP st=' + a.status + ' ' + (a.statusText || '') + (a.preview ? ' [' + a.preview + ']' : ''));
    if (ok1) return { province: prov, city: city, district: district, _debug: 'via AMAP' };
  } catch (e) { diags.push('AMAP ex: ' + (e && e.message ? e.message : '?')); }

  // --- 第 2 道：OpenStreetMap Nominatim（全球通用，CORS 公开）
  try {
    var osmUrl = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' +
                 encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lng) +
                 '&zoom=5&accept-language=zh-CN&addressdetails=1';
    var o = await xhrGet(osmUrl, 7000);
    var ok2 = false;
    if (o.ok && o.text) {
      try {
        var oj = JSON.parse(o.text);
        var a2 = (oj && oj.address) || {};
        var cand = a2.state || a2.province || a2.region || a2.county || '';
        if (cand) {
          prov = String(cand).trim();
          city = String(a2.city || a2.town || a2.municipality || '').trim();
          district = String(a2.suburb || a2.city_district || '').trim();
          ok2 = true;
        }
      } catch (e) { diags.push('OSM parse: ' + (e && e.message ? e.message : 'parse err')); }
    }
    if (!ok2) diags.push('OSM st=' + o.status + ' ' + (o.statusText || '') + (o.preview ? ' [' + o.preview + ']' : ''));
    if (ok2) return { province: prov, city: city, district: district, _debug: 'via OSM' };
  } catch (e) { diags.push('OSM ex: ' + (e && e.message ? e.message : '?')); }

  // --- 第 3 道：ip-api.com（免费无key，国内比 ipwho.is 更准，区分深圳/广州）
  //       HTTPS 版本：https://ipapi.co/json/ 或 http://ip-api.com/json/?lang=zh-CN
  //       ip-api.com 的 HTTPS 端点 https://ipapi.co/json/ 可以直接用
  try {
    var ipapiUrl = 'https://ipapi.co/json/';
    var r3 = await xhrGet(ipapiUrl, 5000);
    var ok3 = false;
    if (r3.ok && r3.text) {
      try {
        var rj = JSON.parse(r3.text);
        if (rj && !rj.error) {
          prov = String(rj.region || rj.province || rj.state || '').trim();
          city = String(rj.city || '').trim();
          if (prov) ok3 = true;
        } else {
          diags.push('IPAPI flag=' + (rj && rj.error ? 'T' : 'F') + ' reason=' + (rj && rj.reason ? String(rj.reason).slice(0, 80) : ''));
        }
      } catch (e) { diags.push('IPAPI parse: ' + (e && e.message ? e.message : 'parse err')); }
    }
    if (!ok3) {
      diags.push('IPAPI st=' + r3.status + ' ' + (r3.statusText || '') + (r3.preview ? ' [' + r3.preview + ']' : ''));
      // 尝试备用 ip-api.com（HTTP，Mixed Content 若被拦就会失败）
      try {
        var r3b = await xhrGet('http://ip-api.com/json/?lang=zh-CN&fields=status,message,country,regionName,city,query', 4000);
        if (r3b.ok && r3b.text) {
          try {
            var rj2 = JSON.parse(r3b.text);
            if (rj2 && rj2.status === 'success') {
              prov = String(rj2.regionName || '').trim();
              city = String(rj2.city || '').trim();
              if (prov) { return { province: prov, city: city, district: '', _debug: 'via IP-API-COM' }; }
            }
          } catch (e) { diags.push('IP-API-COM parse: ' + (e && e.message ? e.message : 'parse err')); }
        }
      } catch (e) { diags.push('IP-API-COM ex: ' + (e && e.message ? e.message : '?')); }
    }
    if (ok3) return { province: prov, city: city, district: district, _debug: 'via IPAPI' };
  } catch (e) { diags.push('IPAPI ex: ' + (e && e.message ? e.message : '?')); }

  // --- 第 4 道：IP 定位（ipwho.is，兜底）—— V136 前是唯一 IP 源，现在放最后兜底
  try {
    var ip = await xhrGet('https://ipwho.is/?lang=zh-CN', 5000);
    var ok4 = false;
    if (ip.ok && ip.text) {
      try {
        var ij = JSON.parse(ip.text);
        if (ij && ij.success !== false) {
          prov = String(ij.region || ij.province || ij.state || '').trim();
          city = String(ij.city || '').trim();
          if (prov) ok4 = true;
        } else {
          diags.push('IPWHOIS flag=' + (ij && ij.success ? 'T' : 'F') + ' msg=' + (ij && ij.message ? String(ij.message).slice(0, 80) : ''));
        }
      } catch (e) { diags.push('IPWHOIS parse: ' + (e && e.message ? e.message : 'parse err')); }
    }
    if (!ok4) diags.push('IPWHOIS st=' + ip.status + ' ' + (ip.statusText || '') + (ip.preview ? ' [' + ip.preview + ']' : ''));
    if (ok4) return { province: prov, city: city, district: district, _debug: 'via IPWHOIS' };
  } catch (e) { diags.push('IPWHOIS ex: ' + (e && e.message ? e.message : '?')); }

  return { province: '', city: '', district: '', _debug: 'ALL_FAIL. ' + diags.join(' | ') };
}

function updateLocateHint(text, kind) {
  const h = els.locateHint;
  if (!h) return;
  // 把 [debug] 行拆成灰色小字，其他按 kind 配色
  const parts = String(text || '').split('\n');
  const mainText = parts[0] || '';
  const debugLine = parts.slice(1).join('\n');
  const mainColor = kind === 'err' ? '#e03131' :
                    kind === 'ok'  ? '#2f9e44' :
                                     'var(--text-2)';
  h.style.color = mainColor;
  if (debugLine) {
    h.innerHTML = escapeHtml(mainText) +
      '<br><span style="color:#868e96;font-size:10.5px;line-height:1.35">' +
      escapeHtml(debugLine) + '</span>';
  } else {
    h.textContent = mainText;
  }
}
function setLocateBtnLabel(txt) {
  if (els.locateBtnLabel) els.locateBtnLabel.textContent = txt;
}

function setupLocateBtn() {
  if (!els.locateBtn) return;
  els.locateBtn.addEventListener('click', () => {
    setLocateBtnLabel('📍 正在定位...');
    updateLocateHint('正在请求系统定位权限，若弹出授权请选择「仅使用期间允许」');
    runLocateFlow(true);
  });
}

// 启动自动定位：先读缓存秒切 pinnedProvince（只置顶，不切到该省），再优先走 GPS（如已授权）+ 逆地理四道兜底，否则回退 IP
// 注意：启动时不切换当前 currentFilter 到定位省份，保持 lastPlay 里的 filter 或默认全部；pinnedProvince 只是影响左侧排序
async function autoDetectProvinceOnLaunch() {
  console.log('[autoDetect] start, LOCATION_KEY=' + LOCATION_KEY);
  // 第一步：从 localStorage 读上次位置 → 只设置 pinnedProvince（用于左侧置顶排序），不切到该省
  let cachedProvince = '';
  let cachedKey = '';
  try {
    const saved = localStorage.getItem(LOCATION_KEY);
    console.log('[autoDetect] cached location saved=' + (saved ? saved.slice(0,120) : 'null'));
    if (saved) {
      const j = JSON.parse(saved);
      if (j && j.province) {
        cachedProvince = j.province;
        cachedKey = normalizeProvinceKey(j.province);
        state.pinnedProvince = cachedKey;
        // V138: 启动静默，只更新 pinnedProvince 用于左侧排序，不再弹绿色提示
        renderCategories();
        console.log('[autoDetect] step1: restored cached province=' + cachedProvince + ' key=' + cachedKey);
      }
    }
  } catch (e) { console.log('[autoDetect] step1 ex: ' + (e&&e.message)); }

  // 第二步：检测 GPS 是否已授权 → 已授权则静默走 GPS + 四道逆地理（更准），未授权才回退 IP
  let grantOk = false;
  try {
    if (typeof window.NativeRadio !== 'undefined' && window.NativeRadio && typeof window.NativeRadio.hasLocationGranted === 'function') {
      grantOk = !!window.NativeRadio.hasLocationGranted();
    } else if (navigator.permissions && navigator.permissions.query) {
      try {
        const pr = await navigator.permissions.query({ name: 'geolocation' });
        grantOk = pr && pr.state === 'granted';
      } catch (e) { grantOk = false; }
    }
  } catch (e) { grantOk = false; }

  let fresh = { province: '', city: '', district: '', _debug: '' };
  if (grantOk) {
    fresh = await new Promise(function (resolve) {
      try {
        navigator.geolocation.getCurrentPosition(async function (pos) {
          try {
            const r = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
            resolve({ province: r.province || '', city: r.city || '', district: r.district || '', _debug: (r._debug || 'via GPS') + ' (startup auto, granted)' });
          } catch (e) { resolve({ province: '', city: '', district: '', _debug: 'GPS reverse ex: ' + (e && e.message ? e.message : '?') }); }
        }, function (err) {
          resolve({ province: '', city: '', district: '', _debug: 'GPS err ' + (err && err.code ? err.code : '?') + ':' + (err && err.message ? err.message : '') });
        }, { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 });
      } catch (e) { resolve({ province: '', city: '', district: '', _debug: 'GPS ex: ' + (e && e.message ? e.message : '?') }); }
    });
  }

  // GPS 没拿到（或无权限）→ 回退 IP 定位兜底
  console.log('[autoDetect] step2: grantOk=' + grantOk + ' fresh.province=' + (fresh.province||'') + ' fresh._debug=' + (fresh._debug||''));
  if (!fresh.province) {
    console.log('[autoDetect] step3: falling back to IP geolocation (ipwho.is)');
    try {
      const ip = await xhrGet('https://ipwho.is/?lang=zh-CN', 5000);
      console.log('[autoDetect] IP response: ok=' + ip.ok + ' status=' + ip.status + ' preview=' + (ip.preview||'').slice(0,200));
      if (ip.ok && ip.text) {
        try {
          const ij = JSON.parse(ip.text);
          console.log('[autoDetect] IP parsed: success=' + ij.success + ' region=' + ij.region + ' province=' + ij.province + ' city=' + ij.city);
          if (ij && ij.success !== false) {
            fresh.province = String(ij.region || ij.province || ij.state || '').trim();
            fresh.city = String(ij.city || '').trim();
            fresh._debug = (grantOk ? (fresh._debug ? fresh._debug + ' → ' : '') : '') + 'via IP (startup auto)';
          } else {
            fresh._debug = (grantOk ? (fresh._debug ? fresh._debug + ' → ' : '') : '') + 'IP flag=' + (ij && ij.success ? 'T' : 'F') + ' msg=' + String(ij && ij.message || '').slice(0, 80);
          }
        } catch (e) { fresh._debug = (grantOk ? (fresh._debug ? fresh._debug + ' → ' : '') : '') + 'IP parse: ' + (e && e.message ? e.message : '?'); }
      } else {
        fresh._debug = (grantOk ? (fresh._debug ? fresh._debug + ' → ' : '') : '') + 'IP st=' + ip.status + ' ' + (ip.statusText || '') + (ip.preview ? ' [' + ip.preview + ']' : '');
      }
    } catch (e) { fresh._debug = (grantOk ? (fresh._debug ? fresh._debug + ' → ' : '') : '') + 'IP ex: ' + (e && e.message ? e.message : '?'); console.log('[autoDetect] IP ex: ' + (e&&e.message)); }
  }

  console.log('[autoDetect] final: fresh.province=' + (fresh.province||'') + ' freshKey will be=' + normalizeProvinceKey(fresh.province||''));
  if (fresh.province) {
    const freshKey = normalizeProvinceKey(fresh.province);
    const changed = (freshKey !== cachedKey);
    state.pinnedProvince = freshKey;
    console.log('[autoDetect] setting pinnedProvince=' + freshKey + ' changed=' + changed);
    try {
      localStorage.setItem(LOCATION_KEY, JSON.stringify({
        province: fresh.province, _key: freshKey, city: fresh.city, district: fresh.district || '', ts: Date.now()
      }));
    } catch (e) {}
    // V138: pinnedProvince 只用于左侧分类排序；启动定位不再提示、不切 currentFilter、不调 applyLocatedProvince
    if (changed) {
      renderCategories();
      console.log('[autoDetect] renderCategories() called after IP locate');
    }
    // 不再显示绿色"已定位到..."提示（用户需求：只置顶，不切省也不提示）
  }
}

function runLocateFlow(fromUserTap) {
  const done = () => { setLocateBtnLabel('📍 自动定位我的城市'); };
  if (!navigator.geolocation || !navigator.geolocation.getCurrentPosition) {
    updateLocateHint('当前环境不支持定位（浏览器/WebView 未启用）', 'err');
    done();
    return;
  }
  try {
    navigator.geolocation.getCurrentPosition(
      async function (pos) {
        try {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          setLocateBtnLabel('📍 正在解析城市...');
          const r = await reverseGeocode(lat, lng);
          const province = r.province || '';
          const city = r.city || '';
          const debugSuffix = (r && r._debug) ? ('\n[debug] ' + String(r._debug).slice(0, 260)) : '';
          if (province) {
            state.pinnedProvince = normalizeProvinceKey(province);
            renderCategories();
          }
          const ok = applyLocatedProvince(province);
          if (ok) {
            const label = city && city !== province ? (province + ' · ' + city) : province;
            updateLocateHint('已定位到：' + label + '，并切到该省电台' + debugSuffix, 'ok');
            try {
              const k = normalizeProvinceKey(province);
              localStorage.setItem(LOCATION_KEY, JSON.stringify({ province, _key: k, city, district: r.district || '', ts: Date.now() }));
            } catch (e) {}
          } else if (province) {
            updateLocateHint('定位到：' + (city || province) + '，但左侧没有对应省份分类' + debugSuffix, 'err');
          } else {
            updateLocateHint('定位成功，但逆地理解析失败（网络或配额原因）' + debugSuffix, 'err');
          }
        } catch (e) {
          updateLocateHint('定位解析异常：' + (e && e.message ? e.message : String(e)), 'err');
        } finally {
          done();
        }
      },
      function (err) {
        const codeMap = { 1:'用户拒绝了定位权限', 2:'位置信息不可用', 3:'定位超时' };
        const msg = codeMap[err && err.code] || ('定位失败 ' + (err && err.message ? err.message : ''));
        if (fromUserTap) {
          updateLocateHint(msg + '。可在「系统设置→应用→海燕收音机→位置权限」开启后重试。', 'err');
        } else {
          updateLocateHint(msg + '（未启用自动定位，功能不受影响）', 'err');
        }
        done();
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 }
    );
  } catch (e) {
    updateLocateHint('定位调用失败：' + (e && e.message ? e.message : String(e)), 'err');
    done();
  }
}

/* ============ SEARCH ============ */
var SEARCH_HISTORY_KEY = 'radio_search_history';
function getSearchHistory() {
  try {
    var s = localStorage.getItem(SEARCH_HISTORY_KEY);
    if (!s) return [];
    var arr = JSON.parse(s);
    return Array.isArray(arr) ? arr : [];
  } catch(e) { return []; }
}
function addSearchHistory(q) {
  q = (q || '').trim();
  if (!q) return;
  var list = getSearchHistory();
  // 移除重复（不区分大小写）
  var ql = q.toLowerCase();
  list = list.filter(function(item) { return item.toLowerCase() !== ql; });
  // 添加到最前
  list.unshift(q);
  // V150: 最多10条
  if (list.length > 10) list = list.slice(0, 10);
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list)); } catch(e) {}
}
function clearSearchHistory() {
  try { localStorage.removeItem(SEARCH_HISTORY_KEY); } catch(e) {}
}
function renderSearchHistory() {
  if (!els.searchHistory || !els.searchHistoryTags) return;
  var list = getSearchHistory();
  if (list.length === 0) {
    els.searchHistory.style.display = 'none';
    return;
  }
  els.searchHistory.style.display = '';
  els.searchHistoryTags.innerHTML = '';
  list.forEach(function(q) {
    var tag = document.createElement('button');
    tag.className = 'search-history-tag';
    tag.textContent = q;
    tag.addEventListener('click', function() {
      els.searchInput.value = q;
      state.searchQuery = q;
      els.searchClear.style.display = 'flex';
      doSearch();
    });
    els.searchHistoryTags.appendChild(tag);
  });
}
function openSearch() {
  state.searchQuery = '';
  els.searchInput.value = '';
  els.searchClear.style.display = 'none';
  els.searchSheet.classList.add('show');
  doSearch();
  setTimeout(()=>els.searchInput.focus(), 100);
}
function closeSearch() {
  els.searchSheet.classList.remove('show');
  state.searchQuery = '';
  if (els.searchHistory) els.searchHistory.style.display = 'none';
  renderChannels();
}
function doSearch() {
  let all = [...state.channels.radio||[], ...state.channels.tv||[]];
  const q = state.searchQuery.trim().toLowerCase();
  if (q) all = all.filter(ch => (ch.name||'').toLowerCase().includes(q) || (ch.frequency||'').toLowerCase().includes(q) || (ch.description||'').toLowerCase().includes(q));
  els.searchResults.innerHTML = '';
  if (!q) {
    // V150: 搜索框为空时，显示搜索历史，隐藏搜索结果
    els.searchResults.style.display = 'none';
    renderSearchHistory();
    return;
  }
  // V150: 有搜索词时，显示搜索结果，隐藏历史
  els.searchResults.style.display = '';
  els.searchHistory.style.display = 'none';
  if (!all.length) {
    els.searchResults.innerHTML = '<div style="text-align:center;color:#6e6e7a;padding:40px 0;font-size:14px">没有找到相关电台</div>';
    return;
  }
  all.slice(0,50).forEach(ch => {
    const el = document.createElement('div');
    el.className = 'search-item';
    el.innerHTML = `
      <div class="search-item-logo">${getChannelIcon(ch)}</div>
      <div class="search-item-info">
        <div class="search-item-name">${escapeHtml(ch.name)}</div>
        <div class="search-item-sub">${escapeHtml(ch.frequency||'')} · ${escapeHtml(ch.description||'')}</div>
      </div>`;
    el.addEventListener('click', () => {
      // V150: 点击搜索结果时，把当前搜索词添加到历史
      addSearchHistory(state.searchQuery);
      playChannel(ch);
      closeSearch();
    });
    els.searchResults.appendChild(el);
  });
  setupLogoFallbacks();
}

/* ============ FULL PLAYER ============ */
function openFullPlayer() { if (state.currentChannel) els.fullPlayer.classList.add('show'); }
function closeFullPlayer() { els.fullPlayer.classList.remove('show'); }

/* ============ MANAGE ============ */
function fillAboutBox() {
  try {
    const b = document.getElementById('aboutVersionBadge');
    const n = document.getElementById('aboutAppName');
    const v = document.getElementById('aboutVersionFull');
    const d = document.getElementById('aboutDataVer');
    if (b) {
      const m = String(DATA_VERSION||'').match(/V(\d+)/);
      b.textContent = VERSION_DISPLAY || ('V' + (m ? m[1] : '82'));
    }
    if (n) n.textContent = '海燕收音机';
    if (v) v.textContent = APP_VERSION || '';
    if (d) d.textContent = 'Data version: ' + (DATA_VERSION || '');
    if (hasNative() && window.NativeRadio && typeof window.NativeRadio.getAppInfo === 'function') {
      try {
        const raw = window.NativeRadio.getAppInfo();
        if (raw) {
          const o = JSON.parse(raw);
          if (o && d) {
            d.textContent = (d.textContent || '')
              + '\nSDK: ' + o.sdk
              + '  品牌: ' + o.brand
              + '  机型: ' + o.model
              + '  内存: ' + o.memoryClass + 'MB';
            d.style.whiteSpace = 'pre-wrap';
          }
        }
      } catch(ign){}
    }
  } catch(ign){}
}
function openManage() {
  closeFullPlayer();
  state.manageFilter = '全部'; // V125: 每次打开管理页默认回到"全部"视图（必须放在renderManageList之前！）
  renderManageList();
  fetchLogoProgress();
  fillAboutBox();
  els.modalSheet.classList.add('show');
}
function renderManageList() {
  const allChannels = [...state.channels.radio||[], ...state.channels.tv||[]];

  // === [1] 统计每个地区的电台数（按 description 字段分组）===
  const regionCount = {};
  allChannels.forEach(ch => {
    const r = ch.description || '其它';
    regionCount[r] = (regionCount[r] || 0) + 1;
  });

  // === [2] 分类列表：严格按 ELECTRON_PROVINCE_ORDER 顺序，"全部"置顶 ===
  const regionTabs = ['全部', ...ELECTRON_PROVINCE_ORDER];
  // 在"个人"后面插入"收藏"管理入口
  const _personalIdx = regionTabs.indexOf('个人');
  if (_personalIdx >= 0) regionTabs.splice(_personalIdx + 1, 0, '收藏');
  const uniqTabs = [];
  regionTabs.forEach(r => { if (!uniqTabs.includes(r)) uniqTabs.push(r); });

  // 2字简称映射（复用 renderCategories 的 shortenRegion 逻辑）
  const labelMap = {
    '全部':'全部','全国':'全国','中央':'中央','电视伴音':'伴音','国际':'国际',
    '北京':'北京','上海':'上海','天津':'天津','重庆':'重庆',
    '香港':'香港','澳门':'澳门','台湾':'台湾',
    '河北':'河北','山西':'山西','辽宁':'辽宁','吉林':'吉林','黑龙江':'龙江',
    '江苏':'江苏','浙江':'浙江','安徽':'安徽','福建':'福建','江西':'江西','山东':'山东',
    '河南':'河南','湖北':'湖北','湖南':'湖南','广东':'广东','广西':'广西','海南':'海南',
    '四川':'四川','贵州':'贵州','云南':'云南','西藏':'西藏',
    '陕西':'陕西','甘肃':'甘肃','青海':'青海','宁夏':'宁夏','新疆':'新疆',
    '内蒙古':'内蒙','海外':'海外','个人':'个人','收藏':'收藏','其它':'其它','自定义':'自定义'
  };
  const shortenRegion = (r) => {
    if (!r) return r;
    if (labelMap[r]) return labelMap[r];
    let s = String(r)
      .replace(/自治区$/g,'').replace(/省$/g,'').replace(/市$/g,'')
      .replace(/维吾尔$/g,'').replace(/壮族$/g,'').replace(/回族$/g,'');
    if (s.length > 2) s = s.slice(0,2);
    return s || r;
  };

  // === [3] 渲染 39 分类按钮到 manageRegionTabs ===
  if (els.manageRegionTabs) {
    const NORMAL_STYLE = 'padding:5px 10px;border-radius:999px;border:1px solid var(--divider);background:var(--surface-2);color:var(--text-2);font-size:11.5px;font-weight:500;cursor:pointer;transition:all .15s;white-space:nowrap;';
    const ACTIVE_STYLE = 'padding:5px 10px;border-radius:999px;border:1px solid #d7263d;background:#d7263d;color:#fff;font-size:11.5px;font-weight:600;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.15);white-space:nowrap;';
    els.manageRegionTabs.innerHTML = uniqTabs.map(r => {
      const label = shortenRegion(r);
      const active = state.manageFilter === r;
      const style = active ? ACTIVE_STYLE : NORMAL_STYLE;
      return `<button class="manage-cat-btn" style="${style}" data-manage-filter="${escapeHtml(r)}">${escapeHtml(label)}</button>`;
    }).join('');
    els.manageRegionTabs.querySelectorAll('.manage-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.manageFilter = btn.dataset.manageFilter;
        renderManageList(); // 重新渲染 = 按钮高亮 + 列表过滤
      });
    });
  }

  // === [4] 更新 Summary / Current 文字 ===
  if (els.manageRegionSummary) {
    const catCount = Object.keys(regionCount).length;
    els.manageRegionSummary.textContent = `共 ${catCount} 分类 / ${allChannels.length} 电台`;
  }
  if (els.manageRegionCurrent) {
    els.manageRegionCurrent.textContent = `当前：${state.manageFilter || '全部'}`;
  }

  // === [5] 按 state.manageFilter 筛选电台（按 description 匹配）===
  let filteredList;
  const isPersonalFilter = state.manageFilter === '个人';
  const isFavoritesFilter = state.manageFilter === '收藏';
  if (isPersonalFilter) {
    // "个人"：显示用户自建电台
    filteredList = state.userStations.map(s => ({
      id: s.id, name: s.name, url: s.url,
      frequency: s.frequency || '', description: s.description || '个人',
      category: s.category || '综合', color: s.color || '#d7263d',
      isUserStation: true
    }));
  } else if (isFavoritesFilter) {
    // "收藏"：显示已收藏的电台（普通+个人），按省份分组排序，有地区的个人电台参与省份排序
    const favNormal = allChannels.filter(ch => state.favorites.includes(ch.id));
    const favUser = state.userStations
      .filter(s => state.favorites.includes(s.id))
      .map(s => ({
        id: s.id, name: s.name, url: s.url,
        frequency: s.frequency || '', description: s.description || '',
        category: s.category || '综合', color: s.color || '#d7263d',
        isUserStation: true
      }));
    const regionGroups = {};
    favNormal.forEach(ch => {
      const r = ch.description || '其它';
      if (!regionGroups[r]) regionGroups[r] = [];
      regionGroups[r].push(ch);
    });
    const favUserNoRegion = [];
    favUser.forEach(ch => {
      const r = ch.description;
      if (r) {
        if (!regionGroups[r]) regionGroups[r] = [];
        regionGroups[r].push(ch);
      } else {
        favUserNoRegion.push(ch);
      }
    });
    Object.keys(regionGroups).forEach(rName => {
      regionGroups[rName] = electronStationSort(rName, regionGroups[rName]);
    });
    const sortedRegions = Object.keys(regionGroups).sort((a,b) => {
      const ia = ELECTRON_PROVINCE_ORDER.indexOf(a);
      const ib = ELECTRON_PROVINCE_ORDER.indexOf(b);
      if (ia !== ib) return ia - ib;
      return a.localeCompare(b, 'zh-CN');
    });
    filteredList = [];
    sortedRegions.forEach(r => { filteredList.push(...regionGroups[r]); });
    filteredList.push(...favUserNoRegion);
  } else if (state.manageFilter === '全部') {
    // "全部"：先按 ELECTRON_PROVINCE_ORDER 顺序排 region，再展平（和主界面逻辑一致）
    const regionGroups = {};
    allChannels.forEach(ch => {
      const r = ch.description || '其它';
      if (!regionGroups[r]) regionGroups[r] = [];
      regionGroups[r].push(ch);
    });
    Object.keys(regionGroups).forEach(rName => {
      regionGroups[rName] = electronStationSort(rName, regionGroups[rName]);
    });
    const sortedRegions = Object.keys(regionGroups).sort((a,b) => {
      const ia = ELECTRON_PROVINCE_ORDER.indexOf(a);
      const ib = ELECTRON_PROVINCE_ORDER.indexOf(b);
      if (ia !== ib) return ia - ib;
      return a.localeCompare(b, 'zh-CN');
    });
    filteredList = [];
    sortedRegions.forEach(r => { filteredList.push(...regionGroups[r]); });
  } else {
    filteredList = allChannels.filter(ch => (ch.description || '其它') === state.manageFilter);
    // 单个 region 内按 cityOrder + zh-CN 排序（复用 electronStationSort）
    filteredList = electronStationSort(state.manageFilter, filteredList);
  }

  // === [6] 渲染：按筛选类型渲染列表 ===
  els.channelManageList.innerHTML = '';

  // ---- 标题行：显示当前筛选 + 数量 + 添加按钮 ----
  const headerRow = document.createElement('div');
  headerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding:0 4px;';
  const headerTitle = document.createElement('div');
  headerTitle.style.cssText = 'font-size:14px;font-weight:700;color:var(--text-primary);';
  headerTitle.textContent = isPersonalFilter ? `📻 个人电台 (${filteredList.length})` : isFavoritesFilter ? `❤️ 收藏电台 (${filteredList.length})` : `📚 预置电台「${state.manageFilter||'全部'}」(${filteredList.length})`;
  headerRow.appendChild(headerTitle);
  if (isPersonalFilter) {
    const addBtn = document.createElement('button');
    addBtn.className = 'personal-add-btn';
    addBtn.style.cssText = 'padding:5px 12px;font-size:12px;color:var(--text-primary)!important;background:var(--surface-hover);border:1px solid var(--border);white-space:nowrap;';
    addBtn.textContent = '+ 添加';
    addBtn.addEventListener('click', openPersonalAdd);
    headerRow.appendChild(addBtn);
  }
  els.channelManageList.appendChild(headerRow);

  // ---- 列表渲染 ----
  if (filteredList.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px;';
    empty.textContent = isPersonalFilter ? '暂无个人电台，点击右上角「+ 添加」创建' : isFavoritesFilter ? '还没有收藏任何电台' : `「${escapeHtml(state.manageFilter)}」分类下暂无电台`;
    els.channelManageList.appendChild(empty);
  } else {
    const displayList = filteredList.slice(0, 500);
    displayList.forEach((ch, i) => {
      const el = document.createElement('div');
      el.className = 'manage-item';
      if (isFavoritesFilter) {
        const editAttr = ch.isUserStation ? `data-self-edit="${ch.id}"` : `data-edit="${ch.id}"`;
        el.innerHTML = `
          <div class="manage-idx">${i+1}</div>
          <div class="manage-info">
            <div class="manage-name">${escapeHtml(ch.name)}</div>
            <div class="manage-sub">${escapeHtml(ch.frequency||'')} · ${escapeHtml(ch.description||'')}</div>
          </div>
          <div class="manage-actions">
            <button class="manage-btn" ${editAttr} title="编辑">✎</button>
            <button class="manage-btn" data-unfav="${ch.id}" title="取消收藏">❤️</button>
          </div>`;
      } else if (isPersonalFilter || ch.isUserStation) {
        el.innerHTML = `
          <div class="manage-idx">${i+1}</div>
          <div class="manage-info">
            <div class="manage-name">${escapeHtml(ch.name)}</div>
            <div class="manage-sub">${escapeHtml(ch.category||'')} · ${escapeHtml(ch.url||'').substring(0,36)}${ch.url&&ch.url.length>36?'...':''}</div>
          </div>
          <div class="manage-actions">
            <button class="manage-btn" data-self-edit="${ch.id}" title="编辑">✎</button>
            <button class="manage-btn danger" data-self-del="${ch.id}" title="删除">🗑</button>
          </div>`;
      } else {
        el.innerHTML = `
          <div class="manage-idx">${i+1}</div>
          <div class="manage-info">
            <div class="manage-name">${escapeHtml(ch.name)}</div>
            <div class="manage-sub">${escapeHtml(ch.frequency||'')} · ${escapeHtml(ch.description||'')}</div>
          </div>
          <div class="manage-actions">
            <button class="manage-btn" data-edit="${ch.id}" title="编辑">✎</button>
            <button class="manage-btn danger" data-del="${ch.id}" title="删除">🗑</button>
          </div>`;
      }
      els.channelManageList.appendChild(el);
    });
    // 绑定事件
    els.channelManageList.querySelectorAll('[data-unfav]').forEach(b => {
      b.addEventListener('click', () => {
        toggleFavorite(b.dataset.unfav);
        renderManageList();
      });
    });
    els.channelManageList.querySelectorAll('[data-self-edit]').forEach(b => {
      b.addEventListener('click', () => openPersonalEdit(b.dataset.selfEdit));
    });
    els.channelManageList.querySelectorAll('[data-self-del]').forEach(b => {
      b.addEventListener('click', () => deleteUserStation(b.dataset.selfDel));
    });
    els.channelManageList.querySelectorAll('[data-edit]').forEach(b => {
      b.addEventListener('click', () => openEditChannel(b.dataset.edit));
    });
    els.channelManageList.querySelectorAll('[data-del]').forEach(b => {
      b.addEventListener('click', () => deleteChannel(b.dataset.del));
    });
  }
}
function openAddChannel() { editingId=null; els.editSheetTitle.textContent='添加电台'; resetForm(); els.editSheet.classList.add('show'); }
function openEditChannel(id) {
  const all = [...state.channels.radio||[], ...state.channels.tv||[]];
  const ch = all.find(c=>c.id===id); if (!ch) return;
  editingId = id; els.editSheetTitle.textContent='编辑电台';
  const f = els.editForm;
  f.name.value = ch.name||''; f.frequency.value = ch.frequency||'';
  f.description.value = ch.description||''; f.url.value = ch.url||'';
  f.color.value = ch.color||'#d4af37';
  els.editSheet.classList.add('show');
}
function resetForm() { const f=els.editForm; f.reset(); f.color.value='#d4af37'; }
function submitEditForm(e) {
  e.preventDefault();
  const fd = new FormData(els.editForm);
  const data = {
    name: (fd.get('name')||'').toString().trim(),
    frequency: (fd.get('frequency')||'').toString().trim(),
    description: (fd.get('description')||'').toString().trim(),
    url: (fd.get('url')||'').toString().trim(),
    color: (fd.get('color')||'#d4af37').toString()
  };
  if (!data.name || !data.url) { showToast('请填写名称和地址'); return; }

  const all = state.channels.radio || [];
  if (editingId) {
    const i = all.findIndex(c=>c.id===editingId);
    if (i>-1) all[i] = Object.assign({}, all[i], data);
    showToast('已更新');
  } else {
    const nid = 'c_' + Date.now();
    all.push(Object.assign({id:nid, category:'综合'}, data));
    state.customChannels.push(nid);
    saveCustomChannels();
    showToast('已添加');
  }
  state.channels.radio = all;
  saveChannels();
  renderCategories();
  renderChannels();
  renderManageList();
  els.editSheet.classList.remove('show');
}
// ════════════════════════════════════════════════════════════════════════
// V169: 删除电台的公共清理(所有删除路径通用，不只个人分类)：
//   若删除的是正在播放的电台 → 停播 + 清currentChannel + 清重连/lastPlay记录
//   防止孤儿流继续出声、防止NET-RECONNECT/崩溃恢复复活已删除电台(V166同款逻辑)
// ════════════════════════════════════════════════════════════════════════
function cleanupDeletedCurrentChannel(id) {
  if (state.currentChannel && state.currentChannel.id === id) {
    stopPlaying();
    state.currentChannel = null;
    if (window.__lastPlayChannel && window.__lastPlayChannel.id === id) window.__lastPlayChannel = null;
    try { if (state.lastPlay && state.lastPlay.id === id) { localStorage.removeItem('radio_last_play'); state.lastPlay = null; } } catch(ign){}
    updatePlayerUI();
    return true;
  }
  return false;
}

async function deleteChannel(id) {
  if (!(await showConfirmDialog('确定删除该电台?', '删除确认'))) return;
  state.channels.radio = (state.channels.radio||[]).filter(c=>c.id!==id);
  saveChannels();
  cleanupDeletedCurrentChannel(id);  // V169: 所有分类的删除都有停播保护
  renderCategories();
  renderChannels();
  renderManageList();
  showToast('已删除');
}
/* ============ V156: SAF (Storage Access Framework) 辅助 ============ */
// 轮询 localStorage 的 resultKey，直到拿到结果或超时（秒）
function safPollResult(resultKey, timeoutSec, callback) {
  var start = Date.now();
  var maxMs = timeoutSec * 1000;
  function tick() {
    try {
      var raw = localStorage.getItem(resultKey);
      if (raw && raw !== 'undefined' && raw !== 'null') {
        localStorage.removeItem(resultKey);
        try { callback(JSON.parse(raw)); }
        catch(e) { callback({ok:false,err:'结果解析失败'}); }
        return;
      }
    } catch(e) {}
    if (Date.now() - start > maxMs) {
      callback({ok:false,err:'等待用户选择超时'});
      return;
    }
    setTimeout(tick, 300);
  }
  tick();
}
// V156: 导入电台列表 → SAF OpenDocument 原生弹系统文件选择器（100% 用户手势，Android 不会拦截）
function safImportChannels() {
  showToast('请选择【.channels.json】电台列表文件…');
  try { localStorage.removeItem('__saf_result_import__'); } catch(e) {}
  fetch('/__nativebackup__/safImport', {cache:'no-store'})
    .then(function(r) { return r.text(); })
    .then(function(txt) {
      try {
        var resp = JSON.parse(txt);
        if (!resp.ok || !resp.launched) { showToast('无法启动文件选择器'); return; }
        safPollResult('__saf_result_import__', 60, function(resp2) {
          if (!resp2.ok) {
            if (resp2.err && resp2.err !== '用户取消') showToast('导入失败：' + resp2.err);
            return;
          }
          try {
            var d = JSON.parse(resp2.content || '{}');
            // V158: 严格校验文件类型，避免把备份文件当电台导入
            var ftype = d && d.__file_type;
            var filename = (resp2.filename || '').toLowerCase();
            // 明确声明是备份 → 直接拒绝，给清晰提示
            if (ftype === 'user_backup') {
              showToast('❌ 文件类型不匹配\n\n这是【备份数据文件】(.backup.json)\n请使用下方「📂 恢复数据」按钮恢复', 3500);
              return;
            }
            // V158 导出格式: 必须有 __file_type === 'channels_export'
            if (ftype === 'channels_export') {
              // 合法格式
            } else if (d.radio && Array.isArray(d.radio)) {
              // V158 之前导出的老格式（没有__file_type但含radio数组），兼容允许
              console.log('[Import] 兼容V157及以前的老格式电台文件（无__file_type）');
            } else {
              showToast('❌ 不是电台列表文件\n\n请选择 .channels.json 格式的电台导出文件', 3500);
              return;
            }
            if (!Array.isArray(d.radio) || d.radio.length === 0) { showToast('文件格式错误：电台列表为空'); return; }
            showConfirmDialog('确定导入电台列表？\n当前电台列表将被覆盖', '导入确认').then(function(ok) {
              if (!ok) return;
              state.channels = { radio: d.radio, tv: Array.isArray(d.tv) ? d.tv : [] };
              sanitizeChannelDescriptions();
              saveChannels();
              renderCategories();
              renderChannels();
              renderManageList();
              showToast('电台导入成功，共 ' + d.radio.length + ' 台');
            });
          } catch(err) { showToast('导入失败：JSON解析错误'); }
        });
      } catch(e2) { showToast('导入失败'); }
    })
    .catch(function(err) { showToast('导入失败：' + err); });
}
// V156: 恢复用户数据 → SAF OpenDocument
function safRestoreUserData() {
  showToast('请选择【.backup.json】备份文件…');
  try { localStorage.removeItem('__saf_result_restore__'); } catch(e) {}
  fetch('/__nativebackup__/safRestore', {cache:'no-store'})
    .then(function(r) { return r.text(); })
    .then(function(txt) {
      try {
        var resp = JSON.parse(txt);
        if (!resp.ok || !resp.launched) { showToast('无法启动文件选择器'); return; }
        safPollResult('__saf_result_restore__', 60, function(resp2) {
          if (!resp2.ok) {
            if (resp2.err && resp2.err !== '用户取消') showToast('恢复失败：' + resp2.err);
            return;
          }
          try {
            var content = resp2.content || '{}';
            var d = JSON.parse(content);
            if (!d || typeof d !== 'object') { showToast('文件格式错误'); return; }

            // V158: 严格校验类型
            var ftype = d.__file_type;
            // 明确声明是电台导出文件 → 拒绝，给提示引导
            if (ftype === 'channels_export') {
              showToast('❌ 文件类型不匹配\n\n这是【电台列表文件】(.channels.json)\n请使用上方「📥 导入」按钮导入', 3500);
              return;
            }

            // 检测是否为用户数据备份（有__file_type='user_backup' 或含 BACKUP_KEYS 中任一有效键）
            var isBackup = !!(ftype === 'user_backup');
            if (!isBackup) {
              for (var i = 0; i < BACKUP_KEYS.length; i++) {
                if (d[BACKUP_KEYS[i]] !== undefined && d[BACKUP_KEYS[i]] !== null) { isBackup = true; break; }
              }
            }
            if (isBackup) {
              showConfirmDialog('确定恢复备份数据？\n\n将覆盖收藏、历史、个人电台、频道编辑等数据', '恢复确认').then(function(ok) {
                if (!ok) return;
                var count = 0;
                BACKUP_KEYS.forEach(function(key) {
                  if (d[key] !== undefined && d[key] !== null) {
                    localStorage.setItem(key, d[key]);
                    count++;
                  }
                });
                showToast('已恢复 ' + count + ' 项数据，正在刷新…');
                setTimeout(function() { try { if (hasNative()) { nativeAudioRpc('stop'); } } catch(ign){} location.reload(); }, 800);
              });
            } else {
              // 既不是channels_export也不是backup → 不认得
              showToast('❌ 不是备份文件\n\n请选择 .backup.json 格式的备份文件', 3500);
            }
          } catch(err) { showToast('恢复失败：' + (err.message || err)); }
        });
      } catch(e2) { showToast('恢复失败'); }
    })
    .catch(function(err) { showToast('恢复失败：' + err); });
}

function exportChannels() {
  // V158: 与备份文件做三方面区分，避免用户混淆：
  //   1) 文件名:  海燕收音机_电台列表_时间戳.channels.json  (双后缀.channels.json肉眼一眼识别)
  //   2) JSON内容: 顶层加 __file_type = 'channels_export' + __export_time
  //   3) 导入时校验: 点「导入」只接受 channels_export 类型或含 radio 数组的旧格式；拿到 backup 文件直接给明确提示
  showToast('请选择保存位置…');
  try {
    var payload = JSON.parse(JSON.stringify(state.channels));
    // 写入类型标识（注：用户编辑的频道保存到localStorage时也会带这个key，但不影响逻辑）
    payload.__file_type = 'channels_export';
    payload.__export_time = new Date().toISOString();
    payload.__app_version = APP_VERSION || '';
    var data = JSON.stringify(payload, null, 2);
    localStorage.setItem('__pending_export_channels__', data);
    localStorage.removeItem('__saf_result_export__');
  } catch(e) {
    showToast('导出失败：' + (e.message || e));
    return;
  }
  var d = new Date();
  var pad = function(n) { return n < 10 ? '0'+n : ''+n; };
  var ts = d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  // V158: 明确前缀 + 双后缀，文件管理器里一眼分清楚
  var filename = '海燕收音机_电台列表_' + ts + '.channels.json';
  fetch('/__nativebackup__/safExport?filename=' + encodeURIComponent(filename), {cache:'no-store'})
    .then(function(r) { return r.text(); })
    .then(function(txt) {
      try {
        var resp = JSON.parse(txt);
        if (!resp.ok || !resp.launched) { showToast('导出失败：无法启动文件选择器'); return; }
        safPollResult('__saf_result_export__', 60, function(resp2) {
          if (resp2.ok) {
            showToast('已导出电台列表\n共 ' + (state.channels && state.channels.radio ? state.channels.radio.length : 0) + ' 台');
          } else if (resp2.err && resp2.err !== '用户取消') {
            showToast('导出失败：' + resp2.err);
          }
        });
      } catch(e2) { showToast('导出失败'); }
    })
    .catch(function(err) { showToast('导出失败：' + err); });
}
function importChannels(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (d.radio) { state.channels = d; saveChannels(); renderCategories(); renderChannels(); renderManageList(); showToast('导入成功'); }
      else showToast('文件格式错误');
    } catch(err) { showToast('导入失败'); }
  };
  r.readAsText(f);
  e.target.value = '';
}
async function resetChannels() {
  if (!(await showConfirmDialog('确定恢复默认电台列表？自定义电台将丢失', '恢复默认'))) return;
  localStorage.removeItem('radio_channels');
  if (typeof CHANNEL_DATA !== 'undefined') state.channels = JSON.parse(JSON.stringify(CHANNEL_DATA));
  saveChannels();
  renderCategories();
  renderChannels();
  renderManageList();
  showToast('已恢复默认');
}

/* ============ V143: 用户数据备份/恢复 ============ */
var BACKUP_KEYS = [
  'radio_favorites',
  'radio_history',
  'radio_user_stations',
  'radio_custom_channels',
  'radio_last_play',
  'radio_last_location',
  'radio_theme_pref',
  'radio_font_pref',
  'radio_channels',
  'radio_search_history'
];
function backupUserData() {
  try {
    console.log('[BACKUP-DIAG] backupUserData called, APP_VERSION=' + (typeof APP_VERSION !== 'undefined' ? APP_VERSION : 'undef'));
  } catch(e) {}

  var data = {};
  var count = 0;
  BACKUP_KEYS.forEach(function(key) {
    var val = localStorage.getItem(key);
    if (val !== null) { data[key] = val; count++; }
  });
  // V158: 与电台导出文件做区分：写 __file_type='user_backup'
  data.__file_type = 'user_backup';
  data.__backup_time = new Date().toISOString();
  data.__app_version = APP_VERSION || '';
  data.__backup_item_count = count;
  var json = JSON.stringify(data, null, 2);
  var d = new Date();
  var pad = function(n) { return n < 10 ? '0'+n : ''+n; };
  var ts = d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  // V158: 中文前缀+双后缀 .backup.json 与 .channels.json 彻底区分
  var filename = '海燕收音机_备份_' + ts + '.backup.json';
  console.log('[BACKUP-DIAG] count=' + count + ' jsonLen=' + json.length + ' filename=' + filename);

  // V156: 改用 SAF ACTION_CREATE_DOCUMENT → 用户选择保存路径
  try {
    localStorage.setItem('__pending_backup__', json);
    localStorage.removeItem('__saf_result_backup__');
  } catch(e) {
    showToast('备份失败：localStorage 存储异常\n' + e);
    return;
  }
  showToast('请选择备份保存位置…');
  var rpcUrl = '/__nativebackup__/safBackup?filename=' + encodeURIComponent(filename);
  console.log('[BACKUP-DIAG] SAF RPC: ' + rpcUrl);
  fetch(rpcUrl, {cache:'no-store'})
    .then(function(r) { return r.text(); })
    .then(function(txt) {
      console.log('[BACKUP-DIAG] SAF launch resp=' + txt);
      try {
        var resp = JSON.parse(txt);
        if (!resp.ok || !resp.launched) { showToast('备份失败：无法启动文件选择器'); return; }
        var pad2 = function(n) { return n < 10 ? '0'+n : ''+n; };
        safPollResult('__saf_result_backup__', 60, function(resp2) {
          if (resp2.ok) {
            var timeStr = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
            showToast('备份完成 ' + count + ' 项数据\n' + timeStr);
          } else if (resp2.err && resp2.err !== '用户取消') {
            showToast('备份失败：' + resp2.err);
          }
        });
      } catch(e) {
        showToast('备份失败：解析响应错误\n' + e);
      }
    })
    .catch(function(err) {
      console.log('[BACKUP-DIAG] SAF RPC error: ' + err);
      showToast('备份失败：' + err);
    });
}
function restoreUserData() {
  // V146: 用 fetch RPC 列出备份文件
  showToast('正在查找备份文件...');
  fetch('/__nativebackup__/list', {cache:'no-store'})
    .then(function(r) {
      console.log('[RESTORE-DIAG] list response status=' + r.status);
      return r.text();
    })
    .then(function(txt) {
      console.log('[RESTORE-DIAG] list response body=' + txt);
      var files = [];
      try { files = JSON.parse(txt || '[]'); } catch(e) {}
      if (files.length === 0) {
        showToast('没有找到备份文件，请先备份');
        return;
      }
      showBackupFilePicker(files);
    })
    .catch(function(err) {
      console.log('[RESTORE-DIAG] list error: ' + err);
      safRestoreUserData(); // V156: 兜底直接走 SAF OpenDocument
    });
}
function showBackupFilePicker(files) {
  var box = document.getElementById('backupFileList');
  if (!box) {
    box = document.createElement('div');
    box.id = 'backupFileList';
    box.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--surface-1,#fff);border-radius:14px;padding:16px;max-width:90vw;max-height:60vh;overflow-y:auto;z-index:9999;box-shadow:0 8px 32px rgba(0,0,0,.25);';
    var overlay = document.createElement('div');
    overlay.id = 'backupFileOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9998;';
    overlay.addEventListener('click', function() { overlay.remove(); box.remove(); });
    document.body.appendChild(overlay);
    document.body.appendChild(box);
  }
  box.innerHTML = '<div style="font-size:14px;font-weight:600;margin-bottom:10px;">选择要恢复的备份</div>';
  files.forEach(function(f) {
    var btn = document.createElement('button');
    btn.className = 'sheet-btn';
    btn.style.cssText = 'width:100%;margin-bottom:6px;text-align:left;font-size:12.5px;';
    // V149: 格式化文件名为可读时间
    var raw = f.replace('retroradio_backup_', '').replace('.json', '');
    var label = raw;
    // 新格式：20260825_000644 → 2026-08-25 00:06:44
    var m1 = raw.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
    if (m1) {
      label = m1[1] + '-' + m1[2] + '-' + m1[3] + ' ' + m1[4] + ':' + m1[5] + ':' + m1[6];
    } else {
      // 旧格式：2026-08-24T16-05-58 → 2026-08-24 16:05:58
      var m2 = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
      if (m2) {
        label = m2[1] + '-' + m2[2] + '-' + m2[3] + ' ' + m2[4] + ':' + m2[5] + ':' + m2[6];
      }
    }
    btn.textContent = label;
    btn.addEventListener('click', function() {
      document.getElementById('backupFileOverlay').remove();
      box.remove();
      restoreFromFile(f);
    });
    box.appendChild(btn);
  });
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'sheet-btn';
  cancelBtn.style.cssText = 'width:100%;margin-top:8px;font-size:12.5px;';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', function() {
    document.getElementById('backupFileOverlay').remove();
    box.remove();
  });
  box.appendChild(cancelBtn);
}
function restoreFromFile(filename) {
  showToast('正在读取备份文件...');
  var rpcUrl = '/__nativebackup__/read?filename=' + encodeURIComponent(filename);
  console.log('[RESTORE-DIAG] read RPC: ' + rpcUrl);
  fetch(rpcUrl, {cache:'no-store'})
    .then(function(r) {
      console.log('[RESTORE-DIAG] read response status=' + r.status);
      return r.text();
    })
    .then(function(txt) {
      console.log('[RESTORE-DIAG] read response bodyLen=' + txt.length);
      try {
        var resp = JSON.parse(txt);
        if (!resp.ok || !resp.content) {
          showToast('读取备份文件失败：' + (resp.err || '未知错误'));
          return;
        }
        var content = resp.content;
        var d = JSON.parse(content);
        if (!d || typeof d !== 'object') { showToast('文件格式错误'); return; }
        showConfirmDialog('确定恢复备份？当前收藏、历史、个人电台等数据将被覆盖', '恢复确认').then(function(ok) {
          if (!ok) return;
          var count = 0;
          BACKUP_KEYS.forEach(function(key) {
            if (d[key] !== undefined && d[key] !== null) {
              localStorage.setItem(key, d[key]);
              count++;
            }
          });
          showToast('已恢复 ' + count + ' 项数据，正在刷新…');
          setTimeout(function() { try { if (hasNative()) { nativeAudioRpc('stop'); } } catch(ign){} location.reload(); }, 800);
        });
      } catch(err) {
        showToast('恢复失败：' + (err.message || err));
      }
    })
    .catch(function(err) {
      console.log('[RESTORE-DIAG] read error: ' + err);
      showToast('恢复失败：' + err);
    });
}
// V155: 用户从系统文件选择器直接选备份文件（importFile/restoreFile change事件）恢复
function restoreFromUserFile(e) {
  var f = e.target.files && e.target.files[0];
  if (!f) return;
  showToast('正在读取备份：' + f.name);
  var fr = new FileReader();
  fr.onload = function() {
    try {
      var content = fr.result;
      var d = JSON.parse(content);
      if (!d || typeof d !== 'object') { showToast('文件格式错误'); return; }
      // 判断是备份数据（有 BACKUP_KEYS 中的字段）还是电台列表导入数据（有 radio 数组）
      var isBackup = false;
      for (var i = 0; i < BACKUP_KEYS.length; i++) {
        if (d[BACKUP_KEYS[i]] !== undefined && d[BACKUP_KEYS[i]] !== null) { isBackup = true; break; }
      }
      if (isBackup) {
        showConfirmDialog('确定恢复备份？当前收藏、历史、个人电台等数据将被覆盖', '恢复确认').then(function(ok) {
          if (!ok) return;
          var count = 0;
          BACKUP_KEYS.forEach(function(key) {
            if (d[key] !== undefined && d[key] !== null) {
              localStorage.setItem(key, d[key]);
              count++;
            }
          });
          showToast('已恢复 ' + count + ' 项数据，正在刷新…');
          setTimeout(function() { try { if (hasNative()) { nativeAudioRpc('stop'); } } catch(ign){} location.reload(); }, 800);
        });
      } else if (d.radio) {
        // 电台列表文件（和 importChannels 一致）
        showConfirmDialog('确定导入电台？当前电台列表将被覆盖', '导入确认').then(function(ok) {
          if (!ok) return;
          state.channels = d;
          saveChannels();
          renderCategories();
          renderChannels();
          renderManageList();
          showToast('导入成功');
        });
      } else {
        showToast('文件格式错误');
      }
    } catch(err) {
      showToast('恢复失败：' + (err.message || err));
    } finally {
      // 重置，下次能选同一文件
      try { e.target.value = ''; } catch(ign){}
    }
  };
  fr.onerror = function() {
    showToast('读取文件失败');
    try { e.target.value = ''; } catch(ign){}
  };
  fr.readAsText(f);
}

/* ============ PERSONAL TAB - 用户自建电台 (V126) ============ */
let editingPersonalId = null;
function openPersonalAdd() {
  editingPersonalId = null;
  els.personalSheetTitle.textContent = '添加个人电台';
  const f = els.personalForm;
  f.reset();
  f.color.value = '#d7263d';
  els.personalSheet.classList.add('show');
}
function openPersonalEdit(id) {
  const s = state.userStations.find(x => x.id === id);
  if (!s) return;
  editingPersonalId = id;
  els.personalSheetTitle.textContent = '编辑个人电台';
  const f = els.personalForm;
  f.name.value = s.name || '';
  f.frequency.value = s.frequency || '';
  f.description.value = s.description || '';
  f.url.value = s.url || '';
  f.category.value = s.category || '综合';
  f.color.value = s.color || '#d7263d';
  els.personalSheet.classList.add('show');
}
function submitPersonalForm(e) {
  e.preventDefault();
  const fd = new FormData(els.personalForm);
  const data = {
    name: (fd.get('name') || '').toString().trim(),
    frequency: (fd.get('frequency') || '').toString().trim(),
    description: (fd.get('description') || '').toString().trim(),
    url: (fd.get('url') || '').toString().trim(),
    category: (fd.get('category') || '综合').toString().trim(),
    color: (fd.get('color') || '#d7263d').toString()
  };
  if (!data.name) { showToast('请填写电台名称'); return; }
  if (!data.url) { showToast('请填写播放地址'); return; }
  if (!/^https?:\/\//i.test(data.url)) { showToast('地址需以 http:// 或 https:// 开头'); return; }

  if (editingPersonalId) {
    const i = state.userStations.findIndex(x => x.id === editingPersonalId);
    if (i > -1) {
      state.userStations[i] = Object.assign({}, state.userStations[i], {
        name: data.name, frequency: data.frequency, description: data.description, url: data.url, category: data.category, color: data.color
      });
      showToast('已更新电台');
      if (state.currentChannel && state.currentChannel.id === editingPersonalId) {
        state.currentChannel = Object.assign({}, state.currentChannel, data);
      }
    }
  } else {
    const nid = 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    state.userStations.push({
      id: nid, name: data.name, frequency: data.frequency, description: data.description, url: data.url,
      category: data.category, color: data.color, createdAt: Date.now()
    });
    showToast('已添加电台');
  }
  saveUserStations();
  renderChannels();
  renderManageList();
  updatePlayerUI();
  els.personalSheet.classList.remove('show');
}
async function deleteUserStation(id) {
  const s = state.userStations.find(x => x.id === id);
  if (!s) return;
  if (!(await showConfirmDialog(`确定删除"${s.name}"吗？`, '删除确认'))) return;
  state.userStations = state.userStations.filter(x => x.id !== id);
  saveUserStations();
  cleanupDeletedCurrentChannel(id);  // V169: 改用公共清理(逻辑与V166一致)
  renderChannels();
  renderManageList();
  showToast('已删除');
}
function openPersonalBatch() {
  if (els.batchTextarea) els.batchTextarea.value = '';
  if (els.batchInfo) els.batchInfo.textContent = '';
  els.batchSheet.classList.add('show');
}

function closeBatchSheet() {
  els.batchSheet.classList.remove('show');
}

function getCsvTemplateText() {
  return '名称,URL,分类,主题色\n' +
    '# 后两列为空时使用默认值：分类=综合，主题色=#d7263d\n' +
    '# 删除此行后填写实际电台\n' +
    'BBC World Service,http://stream.live.vc.bbcmedia.co.uk/bbc_world_service,新闻,#d7263d\n' +
    'CNN News,https://hdls.cnn.com/hls/live/cnn/playlist.m3u8,新闻,\n' +
    '我的电台,http://example.com/stream.m3u8,综合,';
}

function copyTemplateToClipboard() {
  const text = getCsvTemplateText();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('模板已复制到剪贴板');
    }).catch(() => {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast('模板已复制到剪贴板');
  } catch(e) {
    showToast('复制失败，请手动复制');
  }
  document.body.removeChild(ta);
}

function parseAndImportText(text) {
  if (!text || !text.trim()) {
    showToast('请先粘贴电台列表');
    return;
  }
  // 解析文本（复用 handlePersonalBatchFile 的核心逻辑）
  const lines = text.split(/\r?\n/);
  // 自动检测分隔符
  let delim = ',';
  const sampleLine = lines.find(l => l.trim() && !l.trim().startsWith('#')) || '';
  let comma = 0, semicolon = 0, inQ = false;
  for (let i = 0; i < sampleLine.length; i++) {
    const c = sampleLine[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ && c === ',') comma++;
    else if (!inQ && c === ';') semicolon++;
  }
  if (semicolon > comma) delim = ';';
  const dataLines = lines.map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (!dataLines.length) { showToast('没有有效数据'); return; }
  // 跳过表头
  let startIdx = 0;
  const firstFields = parseCsvLine(dataLines[0], delim);
  const joined = firstFields.join(',').toLowerCase();
  if (joined.includes('名称') || joined.includes('name') || (joined.includes('url') && !joined.includes('http'))) {
    startIdx = 1;
  }
  let added = 0, failed = 0;
  for (let i = startIdx; i < dataLines.length; i++) {
    const line = dataLines[i];
    if (!line) { failed++; continue; }
    const fields = parseCsvLine(line, delim);
    if (fields.length < 2) { failed++; continue; }
    const name = fields[0].trim();
    const url = fields[1].trim();
    const category = (fields[2] || '').trim() || '综合';
    const color = (fields[3] || '').trim() || '#d7263d';
    if (!name || !url) { failed++; continue; }
    if (!/^https?:\/\//i.test(url)) { failed++; continue; }
    const nid = 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + String(i);
    state.userStations.push({
      id: nid, name, url, category, color, createdAt: Date.now()
    });
    added++;
  }
  if (!added) {
    showToast('导入失败，请检查格式');
    return;
  }
  saveUserStations();
  renderChannels();
  closeBatchSheet();
  showToast(`成功导入 ${added} 个电台${failed ? '，跳过 '+failed+' 个无效条目' : ''}`);
}

// RFC4180 兼容的 CSV 解析：支持双引号转义、CFLF、分隔符自动检测
function parseCsvLine(line, delim) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuote = true;
      } else if (c === delim) {
        result.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
  }
  result.push(cur);
  return result.map(s => s.trim());
}

function handlePersonalBatchFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  // 兼容：MIME 可能是 text/csv / application/vnd.ms-excel / 空，按扩展名放行
  if (!file.name.toLowerCase().endsWith('.csv')) {
    showToast('请选择 .csv 格式的文件');
    return;
  }
  const reader = new FileReader();
  reader.onload = function(ev) {
    try {
      const buffer = ev.target.result;
      const bytes = new Uint8Array(buffer);
      let text;
      if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        text = new TextDecoder('utf-8').decode(buffer);
      } else if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
        text = new TextDecoder('utf-16le').decode(buffer);
      } else {
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        } catch(_) {
          try {
            text = new TextDecoder('gbk').decode(buffer);
          } catch(__) {
            text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
          }
        }
      }
      text = text.replace(/^\uFEFF/, '');
      parseAndImportText(text);
    } catch(err) {
      console.error('CSV parse error:', err);
      showToast('CSV解析失败：' + (err.message || '未知错误'));
    }
  };
  reader.onerror = function() {
    showToast('读取文件失败');
  };
  reader.readAsArrayBuffer(file);
  e.target.value = ''; // 允许重复选择同一文件
}

/* ============ TIMER ============ */
function openTimer() {
  closeFullPlayer();
  document.querySelectorAll('.timer-chip').forEach(b => b.classList.remove('active'));
  const cur = state.currentTimer;
  const active = document.querySelector('.timer-chip[data-time="'+cur+'"]');
  if (active) active.classList.add('active');
  updateTimerCountdown();
  els.timerSheet.classList.add('show');
}
function setTimer(min) {
  clearInterval(state.timer);
  state.currentTimer = min;
  if (min === 0) { state.timerEnd = 0; els.timerCountdown.textContent=''; return; }
  state.timerEnd = Date.now() + min*60*1000;
  state.timer = setInterval(updateTimerCountdown, 1000);
  showToast('定时关闭已设置 '+min+' 分钟');
  updateTimerCountdown();
}
function updateTimerCountdown() {
  if (!state.timerEnd || state.timerEnd < Date.now()) {
    els.timerCountdown.textContent = '';
    if (state.timerEnd && state.timerEnd < Date.now() && state.isPlaying) {
      state.timerEnd = 0; stopPlaying(); showToast('定时关闭已停止播放');
    }
    return;
  }
  const left = Math.ceil((state.timerEnd - Date.now())/1000);
  const m = Math.floor(left/60); const s = left%60;
  els.timerCountdown.textContent = String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}

/* ============ LOGO / PROGRESS ============ */
async function fetchAndUpdateLogo(ch) {
  if (isNativeApp) return;
  try {
    const r = await fetch(`/api/fetch-logo?name=${encodeURIComponent(ch.name)}&url=${encodeURIComponent(ch.url||'')}`);
    const j = await r.json();
    if (j && j.success) { await reloadChannelsFromServer(); showToast('台标已更新'); }
  } catch(e){}
}
async function reloadChannelsFromServer() {
  if (isNativeApp) return;
  try {
    const r = await fetch('/channels.js?v='+Date.now());
    const t = await r.text();
    const m = t.match(/const CHANNEL_DATA = (\{[\s\S]*\});/);
    if (m) { state.channels = JSON.parse(m[1]); saveChannels(); renderChannels(); updatePlayerUI(); renderCategories(); }
  } catch(e){}
}
async function fetchLogoProgress() {
  if (isNativeApp) { els.logoProgressSection.style.display='none'; return; }
  try {
    const r = await fetch('/api/logo-progress');
    const j = await r.json();
    if (j) {
      els.logoProgressSection.style.display = 'block';
      const f = j.total_fetched || (j.fetched||[]).length || 0;
      const fa = j.total_failed || Object.keys(j.failed||{}).length || 0;
      const t = state.channels.radio.length;
      els.progressFetched.textContent = f; els.progressFailed.textContent = fa; els.progressTotal.textContent = t;
      els.progressFill.style.width = t>0 ? (f/t*100)+'%' : '0%';
    }
  } catch(e){}
}
async function startBatchFetch() {
  if (isNativeApp) { showToast('原生App不支持'); return; }
  try {
    els.fetchLogoBtn.disabled = true; els.fetchLogoBtn.textContent = '获取中...';
    const r = await fetch('/api/start-fetch?size=50&delay=10');
    const j = await r.json();
    if (j.success) { showToast('批量获取已开始'); await reloadChannelsFromServer(); await fetchLogoProgress(); }
    else showToast('获取失败');
  } catch(e) { showToast('获取失败'); }
  finally { els.fetchLogoBtn.disabled = false; els.fetchLogoBtn.textContent = '🚀 手动获取台标'; }
}

/* ============ UTILS ============ */
function escapeHtml(s) {
  return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function showConfirmDialog(msg, title) {
  return new Promise(resolve => {
    els.confirmTitle.textContent = title || '提示';
    els.confirmMsg.textContent = msg;
    els.confirmOverlay.classList.add('show');
    const done = (v) => {
      els.confirmOverlay.classList.remove('show');
      els.confirmOk.removeEventListener('click', onOk);
      els.confirmCancel.removeEventListener('click', onCancel);
      els.confirmOverlay.removeEventListener('click', onOverlay);
      resolve(v);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onOverlay = (e) => { if (e.target === els.confirmOverlay) done(false); };
    els.confirmOk.addEventListener('click', onOk);
    els.confirmCancel.addEventListener('click', onCancel);
    els.confirmOverlay.addEventListener('click', onOverlay);
  });
}

function showToast(msg) {
  try {
    if (!els || !els.toast || !els.toast.parentNode) {
      var t = document.getElementById('toast');
      if (t) els.toast = t;
      else {
        var b = document.body || document.documentElement;
        if (!b) return;
        t = document.createElement('div');
        t.id = 'toast';
        t.className = 'toast';
        b.appendChild(t);
        els.toast = t;
      }
    }
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    // V148 修复：每次都强制设置 opacity:1，避免 setTimeout 中的 opacity:0 !important 覆盖 CSS
    els.toast.style.setProperty('opacity', '1', 'important');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=>{
      try { els.toast.classList.remove('show'); } catch(ign){}
      try { els.toast.style.setProperty('opacity','0','important'); } catch(ign){}
    }, 2200);
  } catch(fatal){ /* swallow */ }
}

document.addEventListener('DOMContentLoaded', init);

/* ============================================================================
   V191 横屏双声道模拟机械指针 VU 表
   ----------------------------------------------------------------------------
   - 横屏且已选电台时自动全屏显示米黄色 classic 双表盘（L/R），竖屏自动收起
   - 电平来源：原生 ExoPlayer 透传 AudioProcessor 统计真实左右声道 RMS
     （WebAudio 无法接入原生播放链路），经 /__nativeaudio__/vulevels 30Hz 轮询
   - JS 做机械 VU 弹道（一阶低通：上升≈300ms 标准，回落更慢）+ 幂曲线角度映射
   - 手动"收起"仅本次横屏有效，回竖屏复位；切台/暂停由 250ms 信息轮询同步
   ============================================================================ */
const landVu = {
  active: false,       // 表盘当前是否显示
  dismissed: false,    // 本次横屏被手动收起
  timer: 0,
  smL: 0, smR: 0,      // 目标能量 0..1（块 RMS×增益，mono 镜像后）
  thetaL: -78, thetaR: -78,  // V197 表头物理仿真：当前角度
  omegaL: 0, omegaR: 0,      // 角速度
  envL: 0, envR: 0,          // V201 目标包络：起音瞬时/回落 τ250ms，针只摆语句上沿
  route: '', routeChk: 0,    // V208 音频路由：'bt'蓝牙 / 'spk'扬声器（2s 查一次）
  dq: [],                    // V208 电平延迟线（蓝牙补偿：元素 {t,l,r}）
  lastT: 0,
  lastInfo: 0
};

function initLandscapeVU() {
  const root = $('landVu');
  if (!root) return;
  const mq = window.matchMedia('(orientation: landscape)');

  const apply = function() {
    const land = mq.matches;
    if (!land) landVu.dismissed = false; // 回竖屏复位手动收起标志
    const shouldShow = land && !!state.currentChannel && !landVu.dismissed;
    if (shouldShow && !landVu.active) showLandVU();
    else if (!shouldShow && landVu.active) hideLandVU();
  };

  if (mq.addEventListener) mq.addEventListener('change', apply);
  else if (mq.addListener) mq.addListener(apply); // 旧 WebView 兼容

  $('lvClose').addEventListener('click', () => { landVu.dismissed = true; hideLandVU(); });
  $('lvPlay').addEventListener('click', () => { togglePlay(); });
  $('lvPrev').addEventListener('click', () => { prevChannel(); });
  $('lvNext').addEventListener('click', () => { nextChannel(); });
  $('lvFav').addEventListener('click', () => {
    if (state.currentChannel) toggleFavorite(state.currentChannel.id);
  });
  $('lvTimerTop').addEventListener('click', openTimer);
  $('lvList').addEventListener('click', openManage);

  landVu._apply = apply;
  apply();
}

function showLandVU() {
  landVu.active = true;
  landVu.smL = 0;
  landVu.smR = 0;
  landVu.thetaL = -78;
  landVu.thetaR = -78;
  landVu.omegaL = 0;
  landVu.omegaR = 0;
  landVu.envL = 0;
  landVu.envR = 0;
  landVu.route = '';
  landVu.routeChk = 0;
  landVu.dq = [];
  landVu.lastT = 0;
  landVu.lastInfo = 0;
  $('landVu').classList.add('show');
  syncLandVUInfo(true);
  // 40Hz：与 PC 版 rAF 手感对齐，CSS 0.08s 过渡负责补间
  // V209: setInterval→rAF 驱动——与屏幕 vsync 相位对齐（interval 平均有 ~8ms 相位差白等），
  //   合成器拿到的是刚算完的最新角度；dt 本就用真实帧间隔，无缝切换
  const loop = () => { if (!landVu.active) return; landVuTick(); landVu.timer = requestAnimationFrame(loop); };
  landVu.timer = requestAnimationFrame(loop);
  console.log('[V192-VU] 横屏表盘显示，40Hz 电平轮询启动');
}

function hideLandVU() {
  landVu.active = false;
  if (landVu.timer) { cancelAnimationFrame(landVu.timer); clearInterval(landVu.timer); landVu.timer = 0; }
  const root = $('landVu');
  if (root) root.classList.remove('show');
}

function landVuTick() {
  if (!landVu.active) return;

  // ---- 1. 拉取真实电平（播放暂停时目标归零，指针自然回落 -20 位）----
  //   V200：RMS + 块内峰值双供能 —— 稳态由 RMS 定形，起音由峰值即时抬针
  //   （46ms 块平均会把音节起音稀释到 1/3 高度，是"视觉滞后"的根源）
  let tl = 0, tr = 0, tpl = 0, tpr = 0;
  if (state.isPlaying && hasNativeAudio()) {
    try {
      const r = nativeAudioRpc('vulevels');
      if (r) { tl = r.l || 0; tr = r.r || 0; tpl = r.pl || 0; tpr = r.pr || 0; }
    } catch (e) { /* 取样失败本帧保持 0 */ }
  }

  // 稳态目标=RMS×增益；起音目标=峰值×0.75（ crest 补偿，取大者）
  const GAIN = 2.2;
  if (tr < 0.004 && tl > 0.004) tpr = tpl;
  if (tl < 0.004 && tr > 0.004) tpl = tpr;
  tl = Math.min(1, Math.max(tl * GAIN, tpl * 0.75));
  tr = Math.min(1, Math.max(tr * GAIN, tpr * 0.75));
  if (tl < 0.004) tl = 0;
  if (tr < 0.004) tr = 0;

  // ---- 1.5 音频路由延迟补偿（V208→V210）----
  //   关键事实：AudioProcessor 位于 ExoPlayer/AudioTrack 深缓冲【之前】，音频要
  //   在输出缓冲排队 150~250ms 才出声 —— 针看到的电平比耳朵早一大截（超前）。
  //   V207~V209 把针链路压到 ~70ms 后超前感反而放大（"越调越不同步"的真相）。
  //   补偿 = 出声总延迟 − 针链路(~70ms)：扬声器 sink~200+30−70 ≈ 150ms；
  //   蓝牙再叠加 A2DP 编解码 150~250ms ≈ 300ms。电平延迟线让针"等"声音。
  const nowMs = Date.now();
  if (nowMs - landVu.routeChk > 2000) {
    landVu.routeChk = nowMs;
    try {
      const rr = nativeAudioRpc('hasextaudio');
      landVu.route = (rr && rr.ok && rr.has) ? 'bt' : 'spk';
    } catch (e) { /* 查询失败保持上次路由 */ }
  }
  const syncMs = landVu.route === 'bt' ? 300 : 400;
  if (nowMs - landVu.routeChk >= 2000) console.log('[V216-VU] route=' + landVu.route + ' syncMs=' + syncMs + ' dq=' + landVu.dq.length);
  if (syncMs > 0) {
    landVu.dq.push({ t: nowMs, l: tl, r: tr });
    if (landVu.dq.length > 120) landVu.dq.splice(0, landVu.dq.length - 120); // 卡顿兜底
    while (landVu.dq.length && nowMs - landVu.dq[0].t > syncMs) {
      const d = landVu.dq.shift();
      tl = d.l; tr = d.r;
    }
  } else if (landVu.dq.length) {
    landVu.dq.length = 0;
  }

  // ---- 2. 三级弹道（职责正交，V202 定稿结构）----
  //   ① Java 峰值供能：字头目标即时抬高（不被 46ms 块平均稀释）
  //   ② 目标包络（本级）：非对称单极点 —— 上升 α0.55（τ≈37ms，峰值供能下字头
  //      约 1~2 帧冲顶（V203：AUP 0.55→0.7 起音加速），快且带机械加速感）/ 回落 α0.10（τ≈250ms，只摆语句上沿）。
  //      V201 教训：上升瞬时(α=1)会把块间 25ms 电平小波动全量透传 → 针高频颤。
  //   ③ 动圈表头（下段）：fn5.0Hz/ζ0.9（V213：回滚 V209 的 α0.9/fn5.6——震颤回归源头，回 V207/V208 已验证稳定点）
  const AUP = 0.8, ADOWN = 0.10;
  landVu.envL += (tl > landVu.envL ? AUP : ADOWN) * (tl - landVu.envL);
  landVu.envR += (tr > landVu.envR ? AUP : ADOWN) * (tr - landVu.envR);
  if (landVu.envL < 0.0008) landVu.envL = 0;
  if (landVu.envR < 0.0008) landVu.envR = 0;
  landVu.smL = landVu.envL;
  landVu.smR = landVu.envR;
  const nowT = performance.now();
  let dt = (nowT - landVu.lastT) / 1000;
  landVu.lastT = nowT;
  if (!(dt > 0) || dt > 0.04) dt = 0.04;  // fn6.5Hz: ωn·dt 须 <2（半隐式欧拉稳定域）
  if (dt < 0.005) dt = 0.005;
  const K = 987, C = 56.5;  // V213: 回滚 fn5.0Hz/ζ0.9（V209 fn5.6+α0.9 致震颤回归）
  const tL = -78 + Math.pow(landVu.smL, 0.7) * 156;
  const tR = -78 + Math.pow(landVu.smR, 0.7) * 156;
  landVu.omegaL += (K * (tL - landVu.thetaL) - C * landVu.omegaL) * dt;
  landVu.thetaL += landVu.omegaL * dt;
  landVu.omegaR += (K * (tR - landVu.thetaR) - C * landVu.omegaR) * dt;
  landVu.thetaR += landVu.omegaR * dt;
  if (landVu.thetaL < -80) { landVu.thetaL = -80; landVu.omegaL = 0; }
  if (landVu.thetaL > 80)  { landVu.thetaL = 80;  landVu.omegaL = 0; }
  if (landVu.thetaR < -80) { landVu.thetaR = -80; landVu.omegaR = 0; }
  if (landVu.thetaR > 80)  { landVu.thetaR = 80;  landVu.omegaR = 0; }
  const aL = landVu.thetaL, aR = landVu.thetaR;
  const nL = $('vuNeedleLeft'), nR = $('vuNeedleRight');
  if (nL) nL.style.transform = 'translateX(-50%) rotate(' + aL.toFixed(1) + 'deg)';
  if (nR) nR.style.transform = 'translateX(-50%) rotate(' + aR.toFixed(1) + 'deg)';

  // ---- 4. 低频同步电台信息/状态/收藏/播放图标（250ms）----
  syncLandVUInfo(false);
}

function syncLandVUInfo(force) {
  const now = Date.now();
  if (!force && now - landVu.lastInfo < 250) return;
  landVu.lastInfo = now;

  const ch = state.currentChannel;
  if (!ch) { hideLandVU(); return; }

  const nameEl = $('lvName'), subEl = $('lvSub'), statusEl = $('lvStatus');
  if (nameEl) nameEl.textContent = ch.name || '';
  if (subEl) {
    const sub = ch.category
      ? ch.category
      : ((ch.frequency || '') + (ch.description ? ' · ' + ch.description : ''));
    subEl.textContent = sub || '正在直播';
  }
  if (statusEl) statusEl.textContent = state.isPlaying ? '正在直播' : '已暂停';
  const fav = $('lvFav');
  if (fav) fav.classList.toggle('active', state.favorites.includes(ch.id));
  const playBtn = $('lvPlay');
  if (playBtn) {
    playBtn.innerHTML = state.isPlaying
      ? '<svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor"><path d="M6.5 5h4v14h-4zM13.5 5h4v14h-4z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor"><path d="M7 5v14l11-7z"/></svg>';
  }
}
