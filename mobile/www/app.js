const state = {
  channels: { radio: [], tv: [] },
  currentChannel: null,
  isPlaying: false,
  favorites: [],
  history: [],
  customChannels: [],
  currentFilter: '全部',
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

const DATA_VERSION = '20260801-V82-BADGE-MOVED-TO-ABOUT-NO-PLAY-TOAST';
const APP_VERSION = 'v1.3.82 (b82 版本号从顶部移入管理→关于; 播放/播放失败Toast不显示; V81根因修复保留)';
const DATA_VERSION_KEY = 'radio_data_version';
const THEME_KEY = 'radio_theme_pref';
const FONT_KEY = 'radio_font_pref';
const LOCATION_KEY = 'radio_last_location';

const isNativeApp = (typeof window.Capacitor !== 'undefined' && window.Capacitor.isNativePlatform) || (typeof window.NativeRadio !== 'undefined');

const els = {};
let editingId = null;

function $(id) { return document.getElementById(id); }

function hasNative() { return typeof window.NativeRadio !== 'undefined' && window.NativeRadio; }

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
    }
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
  const onVis = () => {
    const hidden = document.hidden || document.visibilityState !== 'visible';
    document.documentElement.classList.toggle('app-hidden', hidden);
    if (hidden) {
      document.querySelectorAll('.fp-logo-inner, .card-logo img').forEach(el => el.style.animationPlayState = 'paused');
    } else {
      document.querySelectorAll('.fp-logo-inner, .card-logo img').forEach(el => el.style.animationPlayState = '');
    }
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('blur', onVis);
  window.addEventListener('pagehide', onVis);
  window.addEventListener('focus', () => { document.documentElement.classList.remove('app-hidden'); });
  window.addEventListener('nativeRadio', (e) => {
    const type = e && e.detail ? e.detail.type : null;
    if (!type) return;
    console.log('[nativeRadio] event=' + type);
    switch (type) {
      case 'play':
        if (state.playbackEngine === 'web' && state.currentChannel && state.audioElement) {
          state.audioElement.play().catch((err) => { console.warn('[nativeRadio] play() catch:', err && err.message ? err.message : err); });
        }
        state.isPlaying = true; updatePlayerUI();
        break;
      case 'pause':
        if (state.playbackEngine === 'web' && state.audioElement) state.audioElement.pause();
        state.isPlaying = false; updatePlayerUI();
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
    initAnalogClock();
    renderCategories();
    renderChannels();
    updateTopRegion();
    setupEventListeners();
    setupThemeSwitcher();
    setupFontSwitcher();
    setupLocateBtn();
    setupAudio();
    reportNativeState(true);
    startMiniProgressTicker();
    autoDetectProvinceOnLaunch();
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
  setInterval(updateAnalogClock, 1000);
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
  if (se) se.setAttribute('transform', `rotate(${secDeg} 50 50)`);
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

  els.modalSheet = $('modalSheet');
  els.sheetTitle = $('sheetTitle');
  els.sheetClose = $('sheetClose');
  els.addChannelBtn = $('addChannelBtn');
  els.exportBtn = $('exportBtn');
  els.importBtn = $('importBtn');
  els.resetBtn = $('resetBtn');
  els.channelManageList = $('channelManageList');
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

  els.importFile = $('importFile');
  els.toast = $('toast');
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
  setInterval(update, 1000);
}

/* ============ STORAGE ============ */
function saveChannels() { try { localStorage.setItem('radio_channels', JSON.stringify(state.channels)); } catch(e){} }
function loadFavorites() { try { state.favorites = JSON.parse(localStorage.getItem('radio_favorites')||'[]'); } catch(e){ state.favorites=[]; } }
function saveFavorites() { try { localStorage.setItem('radio_favorites', JSON.stringify(state.favorites)); } catch(e){} }
function loadHistory() { try { state.history = JSON.parse(localStorage.getItem('radio_history')||'[]'); } catch(e){ state.history=[]; } }
function saveHistory() { try { localStorage.setItem('radio_history', JSON.stringify(state.history)); } catch(e){} }
function loadCustomChannels() { try { state.customChannels = JSON.parse(localStorage.getItem('radio_custom_channels')||'[]'); } catch(e){ state.customChannels=[]; } }
function saveCustomChannels() { try { localStorage.setItem('radio_custom_channels', JSON.stringify(state.customChannels)); } catch(e){} }

/* ============ Electron版 processChannels (100%字节级复制自根目录app.js第119-669行) ============ */
function processChannels(data) {
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
        const lm = r.url.match(/(\/live\/[a-z0-9]+\/playlist\.m3u8)/i);
        if (lm) r.url = 'https://satellitepull.cnr.cn' + lm[1];
      }
    }
  }
  const regionCounts = {};
  const regionNames = new Set();
  const debugInfo = [];
  const duplicateInfo = [];
  for (let i = 0; i < uniqueRadio.length; i++) {
    const r = uniqueRadio[i];
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
  console.log('分类数量总和:', total, ', uniqueRadio长度:', uniqueRadio.length);
  console.log('分类统计对象的键数量:', Object.keys(regionCounts).length);
  const hongKongStations = uniqueRadio.filter(r => r.name.includes('香港'));
  console.log('所有包含"香港"的电台:', hongKongStations.map(r => ({ name: r.name, desc: r.description })));
  const unclassifiedStations = uniqueRadio.filter(r => !regions.some(reg => reg.name === r.description));
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
  
  return { radio: uniqueRadio, tv };
}

// Electron版真实分类顺序（来自app.js provinceOrder）
const ELECTRON_REGION_ORDER = [
  '全部','收藏','历史',
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
  '内蒙古', '海外', '其它'
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
function loadChannels() {
  const STORAGE_KEY = 'radio_channels';
  try {
    const savedVer = localStorage.getItem(DATA_VERSION_KEY);
    const forceReset = savedVer !== DATA_VERSION;
    console.log('[V66 loadChannels]['+APP_VERSION+'] savedVer='+(savedVer||'')+' required='+DATA_VERSION+' forceReset='+forceReset);
    
    if (typeof CHANNEL_DATA !== 'undefined' && CHANNEL_DATA.radio) {
      const processed = processChannels(CHANNEL_DATA);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(processed));
      localStorage.setItem(DATA_VERSION_KEY, DATA_VERSION);
      state.channels = processed;
      
      // 校验统计
      const gucheng = processed.radio.filter(c => /故城/.test(c.name));
      const jjzsArr = processed.radio.filter(c => /经济之声/.test(c.name));
      const centralRaw = processed.radio.filter(c => c.description === '中央');
      // === 关键点：中央排序按Electron buildStationTree的localeCompare(zh-CN)排序（和用户截图一致）===
      const centralSorted = electronStationSort('中央', centralRaw);
      console.log('[loadChannels] 总台数='+processed.radio.length+' 中央='+centralSorted.length+' 故城='+gucheng.length);
      console.log('[loadChannels] 中央明细(Electron排序后): '+centralSorted.map(function(c,i){ return (i+1)+'.'+c.name+'|'+c.url.substring(0,50); }).join(' · '));
      if (jjzsArr.length > 0) {
        console.log('[loadChannels] 经济之声URL='+jjzsArr[0].url+' id='+jjzsArr[0].id);
      }
      if (gucheng.length > 0) {
        console.log('[loadChannels] 故城县电台明细: '+gucheng.map(c => c.name+' desc='+c.description).join(' | '));
      }
      const toastMsg = APP_VERSION + ' 总数='+processed.radio.length+' 中央='+centralSorted.length+' URL1='+(jjzsArr[0]?jjzsArr[0].url.substring(jjzsArr[0].url.indexOf('//')+2, jjzsArr[0].url.indexOf('/live')):'?');
      try {
        showToast(toastMsg);
        clearTimeout(showToast._t);
        showToast._t = setTimeout(function(){ try { els.toast.classList.remove('show'); } catch(e){} }, 8000);
      } catch(tErr){}
      return;
    }
  } catch (e) {
    console.warn('[V66 loadChannels] 处理频道数据失败', e);
  }
  // fallback
  try {
    const saved = localStorage.getItem('radio_channels');
    if (saved) { state.channels = JSON.parse(saved); }
    else { state.channels = { radio: [], tv: [] }; }
  } catch(e2) {
    state.channels = { radio: [], tv: [] };
  }
}

/* ============ CATEGORIES (严格Electron顺序 - 左侧垂直导航) ============ */
// 不参与「省份排序」的前几个功能分类（永远在最前）
const HEADER_CATEGORIES = ['全部', '收藏', '历史', '全国', '中央', '电视伴音', '国际'];
// 不参与「省份排序」的后几个功能分类（永远在最后）
const TAIL_CATEGORIES = ['海外', '其它', '自定义'];

function getCategoryList() {
  const all = [...state.channels.radio || [], ...state.channels.tv || []];
  const hasRegion = {};
  all.forEach(ch => { hasRegion[ch.description || '全国'] = true; });
  if (state.favorites.length) hasRegion['收藏'] = true;
  if (state.history.length) hasRegion['历史'] = true;
  hasRegion['全部'] = true;
  const MAIN_REGIONS = ELECTRON_REGION_ORDER.filter(r => !['其它'].includes(r));
  let list = MAIN_REGIONS.filter(r => {
    if (['全部','收藏','历史'].includes(r)) return true;
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
    const map = { '全部':'全部', '收藏':'收藏', '历史':'历史', '自定义':'自定义' };
    els.topRegion.textContent = map[state.currentFilter] || state.currentFilter;
  }
}

function renderCategories() {
  const cats = getCategoryList();
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
    '自定义':'自定义'
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
  let list = [...state.channels.radio || [], ...state.channels.tv || []];

  // 功能分类：收藏/历史/自定义 - 保持原始顺序（按收藏/收听顺序）
  if (state.currentFilter === '收藏') return list.filter(ch => state.favorites.includes(ch.id));
  if (state.currentFilter === '历史') return list.filter(ch => state.history.includes(ch.id));
  if (state.currentFilter === '自定义') return list.filter(ch => state.customChannels.includes(ch.id));

  // 按description分region，每个region内严格按Electron排序
  const regionGroups = {};
  list.forEach(function(ch) {
    const region = ch.description || '其它';
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

function makeChannelListItem(ch) {
  const isActive = state.currentChannel && state.currentChannel.id === ch.id;
  const isFavorite = state.favorites.includes(ch.id);
  const el = document.createElement('div');
  el.className = 'channel-list-item' + (isActive ? ' active' : '');
  const subParts = [];
  if (ch.frequency) subParts.push(ch.frequency);
  if (ch.description) subParts.push(ch.description);
  const hasLive = isActive && !!state.isPlaying;
  el.innerHTML = `
    <div class="channel-list-logo">${getChannelIcon(ch)}</div>
    <div class="channel-list-info">
      <div class="channel-list-name">${escapeHtml(ch.name||'电台')}</div>
      <div class="channel-list-sub">
        ${hasLive ? `<span class="channel-list-badge live">直播中</span>` : ''}
        <span>${escapeHtml(subParts.join(' · ') || '网络电台')}</span>
      </div>
    </div>
    <button class="channel-list-fav ${isFavorite?'active':''}" data-id="${ch.id}" aria-label="收藏">
      <svg viewBox="0 0 24 24" fill="${isFavorite?'currentColor':'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
    </button>
  `;
  el.addEventListener('click', e => {
    if (e.target.closest('.channel-list-fav')) return;
    playChannel(ch);
  });
  const favBtn = el.querySelector('.channel-list-fav');
  favBtn.addEventListener('click', e => {
    e.stopPropagation();
    toggleFavorite(ch.id);
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
  if (!channels.length) {
    if (state.currentFilter !== '全部' && state.currentFilter !== '收藏' && state.currentFilter !== '历史') {
      els.emptyState.querySelector('.empty-text').textContent = state.currentFilter + '暂无电台';
    } else if (state.searchQuery) {
      els.emptyState.querySelector('.empty-text').textContent = '没有找到相关电台';
    } else if (state.currentFilter === '收藏') {
      els.emptyState.querySelector('.empty-text').textContent = '还没有收藏任何电台';
    } else if (state.currentFilter === '历史') {
      els.emptyState.querySelector('.empty-text').textContent = '还没有收听历史';
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
  if (els.fpStatus) els.fpStatus.textContent = '已暂停';
  updatePlayerUI();
  reportNativeState();
}

function playChannel(ch) {
  if (!ch) return;
  // V61: Log version + radio id + url to logcat, tiny visual toast too to PROOF NEW CODE RUNS!
  console.log('[playChannel]['+APP_VERSION+'] id=' + (ch.id||'?') + ' name=' + ch.name + ' url=' + ch.url + ' desc=' + (ch.description||''));
  // V82: 不再在播放时弹Toast，只保留console日志
  // try { showToast('▶ 播放 '+ch.name); clearTimeout(showToast._t); showToast._t=setTimeout(()=>{try{els.toast.classList.remove('show')}catch(ign){}},2200); } catch(ign){}
  const switchingAway = (state.currentChannel && state.currentChannel.id !== ch.id);
  // v56: Soft pre-clean only. No audio.pause(), no src wipe. Destroy any
  // attached prior hls.js instance before we hand off to the new load.
  if (state.hls) { try { state.hls.destroy(); } catch(ign){} state.hls = null; }
  state.currentChannel = ch;
  state.playbackEngine = 'web';
  updatePlayerUI();
  renderChannels();
  addToHistory(ch.id);
  if (els.fpStatus) els.fpStatus.textContent = '缓冲中...';
  playChannelWithWebEngine(ch);
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
      state.hls.on(Hls.Events.MANIFEST_PARSED, function onManifestParsed(){
        console.log('[WebEngine] HLS(hls.js) manifest OK -> call audio.play()');
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
      });
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
  if (state.playbackEngine === 'native' && hasNative() && typeof window.NativeRadio.togglePlayNative === 'function') {
    try {
      window.NativeRadio.togglePlayNative();
      state.isPlaying = !state.isPlaying;
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
  setInterval(tick, 1000);
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
          // nothing
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
  els.importBtn.addEventListener('click', () => els.importFile.click());
  els.resetBtn.addEventListener('click', resetChannels);
  els.importFile.addEventListener('change', importChannels);
  els.fetchLogoBtn && els.fetchLogoBtn.addEventListener('click', startBatchFetch);
  els.editForm.addEventListener('submit', submitEditForm);

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

// 逆地理：三道兜底（高德 → OSM Nominatim → IP 定位），任何一道拿到省就算成功
// 失败时返回的对象里加 _debug 字段，上层会把它显示到提示里帮助诊断
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

  // --- 第 3 道：IP 定位（精度到省，不需要权限，兜底）
  try {
    var ip = await xhrGet('https://ipwho.is/?lang=zh-CN', 5000);
    var ok3 = false;
    if (ip.ok && ip.text) {
      try {
        var ij = JSON.parse(ip.text);
        if (ij && ij.success !== false) {
          prov = String(ij.region || ij.province || ij.state || '').trim();
          city = String(ij.city || '').trim();
          if (prov) ok3 = true;
        } else {
          diags.push('IPWHOIS flag=' + (ij && ij.success ? 'T' : 'F') + ' msg=' + (ij && ij.message ? String(ij.message).slice(0, 80) : ''));
        }
      } catch (e) { diags.push('IPWHOIS parse: ' + (e && e.message ? e.message : 'parse err')); }
    }
    if (!ok3) diags.push('IPWHOIS st=' + ip.status + ' ' + (ip.statusText || '') + (ip.preview ? ' [' + ip.preview + ']' : ''));
    if (ok3) return { province: prov, city: city, district: district, _debug: 'via IP' };
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

// 启动自动定位：先读缓存秒切 pinnedProvince，再优先走 GPS（如已授权）+ 逆地理四道兜底，否则回退 IP（无权限、不打扰 UI）
async function autoDetectProvinceOnLaunch() {
  // 第一步：从 localStorage 读上次位置 → 秒切 pinnedProvince，不用等网络
  let cachedProvince = '';
  let cachedKey = '';
  try {
    const saved = localStorage.getItem(LOCATION_KEY);
    if (saved) {
      const j = JSON.parse(saved);
      if (j && j.province) {
        cachedProvince = j.province;
        cachedKey = normalizeProvinceKey(j.province);
        state.pinnedProvince = cachedKey;
        applyLocatedProvince(j.province);
        renderCategories();
        updateLocateHint('已按上次位置自动选择：' + (j.city || j.province), 'ok');
      }
    }
  } catch (e) {}

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
  if (!fresh.province) {
    try {
      const ip = await xhrGet('https://ipwho.is/?lang=zh-CN', 5000);
      if (ip.ok && ip.text) {
        try {
          const ij = JSON.parse(ip.text);
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
    } catch (e) { fresh._debug = (grantOk ? (fresh._debug ? fresh._debug + ' → ' : '') : '') + 'IP ex: ' + (e && e.message ? e.message : '?'); }
  }

  if (fresh.province) {
    const freshKey = normalizeProvinceKey(fresh.province);
    const changed = (freshKey !== cachedKey);
    state.pinnedProvince = freshKey;
    try {
      localStorage.setItem(LOCATION_KEY, JSON.stringify({
        province: fresh.province, _key: freshKey, city: fresh.city, district: fresh.district || '', ts: Date.now()
      }));
    } catch (e) {}
    const applied = applyLocatedProvince(fresh.province);
    if (changed) renderCategories();
    // 如果是从缓存已经成功的，刷新后结果相同就不再改提示，保持静默；不同才更新提示
    if (changed || !cachedKey) {
      const label = fresh.city && fresh.city !== fresh.province ? (fresh.province + ' · ' + fresh.city) : fresh.province;
      const hint = (applied ? '已定位到：' + label + '，已自动切到该省电台（启动自动定位）'
                            : '已定位到：' + label + '（启动自动定位）')
                 + '\n[debug] ' + (fresh._debug || 'via IP');
      updateLocateHint(hint, applied ? 'ok' : 'info');
    }
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
          updateLocateHint(msg + '。可在「系统设置→应用→复古收音机→位置权限」开启后重试。', 'err');
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
  renderChannels();
}
function doSearch() {
  let all = [...state.channels.radio||[], ...state.channels.tv||[]];
  const q = state.searchQuery.trim().toLowerCase();
  if (q) all = all.filter(ch => (ch.name||'').toLowerCase().includes(q) || (ch.frequency||'').toLowerCase().includes(q) || (ch.description||'').toLowerCase().includes(q));
  els.searchResults.innerHTML = '';
  if (!q) {
    els.searchResults.innerHTML = '<div style="text-align:center;color:#6e6e7a;padding:40px 0;font-size:14px">输入关键词搜索电台</div>';
    return;
  }
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
    el.addEventListener('click', () => { playChannel(ch); closeSearch(); });
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
      b.textContent = 'V' + (m ? m[1] : '82');
    }
    if (n) n.textContent = '复古网络收音机';
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
  renderManageList();
  fetchLogoProgress();
  fillAboutBox();
  els.modalSheet.classList.add('show');
}
function renderManageList() {
  const all = [...state.channels.radio||[], ...state.channels.tv||[]];
  els.channelManageList.innerHTML = '';
  all.slice(0,120).forEach((ch, i) => {
    const el = document.createElement('div');
    el.className = 'manage-item';
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
    els.channelManageList.appendChild(el);
  });
  els.channelManageList.querySelectorAll('[data-edit]').forEach(b => {
    b.addEventListener('click', () => openEditChannel(b.dataset.edit));
  });
  els.channelManageList.querySelectorAll('[data-del]').forEach(b => {
    b.addEventListener('click', () => deleteChannel(b.dataset.del));
  });
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
function deleteChannel(id) {
  if (!confirm('确定删除该电台?')) return;
  state.channels.radio = (state.channels.radio||[]).filter(c=>c.id!==id);
  saveChannels();
  renderCategories();
  renderChannels();
  renderManageList();
  showToast('已删除');
}
function exportChannels() {
  const data = JSON.stringify(state.channels, null, 2);
  const blob = new Blob([data], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'radio_channels_'+Date.now()+'.json';
  a.click();
  showToast('已导出');
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
function resetChannels() {
  if (!confirm('确定恢复默认电台列表？自定义电台将丢失')) return;
  localStorage.removeItem('radio_channels');
  if (typeof CHANNEL_DATA !== 'undefined') state.channels = JSON.parse(JSON.stringify(CHANNEL_DATA));
  saveChannels();
  renderCategories();
  renderChannels();
  renderManageList();
  showToast('已恢复默认');
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
        t.style.cssText = 'position:fixed;left:50%;bottom:12vh;transform:translateX(-50%);max-width:92vw;padding:10px 14px;border-radius:10px;background:rgba(30,30,30,.92);color:#fff;font-size:13.5px;line-height:1.5;font-weight:600;z-index:999999;text-align:center;box-shadow:0 4px 16px rgba(0,0,0,.38);opacity:0;pointer-events:none;transition:opacity .2s;white-space:pre-wrap;';
        b.appendChild(t);
        els.toast = t;
      }
    }
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    if (!els.toast.classList.contains('show')) {
      els.toast.style.setProperty('opacity', '1', 'important');
    }
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=>{
      try { els.toast.classList.remove('show'); } catch(ign){}
      try { els.toast.style.setProperty('opacity','0','important'); } catch(ign){}
    }, 2200);
  } catch(fatal){ /* swallow */ }
}

document.addEventListener('DOMContentLoaded', init);
