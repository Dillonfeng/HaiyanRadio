/* ============================================================
   复古收音机 & 电视机 - 应用逻辑
   ============================================================ */

(function () {
  'use strict';

  /* -------------------- 默认频道数据 -------------------- */
  const DEFAULT_CHANNELS = {
    radio: [
      { id: 'r1', name: 'BBC World Service', frequency: '88.5 FM', url: 'https://stream.live.vc.bbcmedia.co.uk/bbc_world_service', color: '#d4af37', description: '国际新闻与访谈', category: 'news' },
      { id: 'r2', name: 'NPR News',          frequency: '95.1 FM', url: 'https://npr-ice.streamguys1.com/live-nprnews-128.mp3', color: '#4a90e2', description: '美国国家公共电台', category: 'news' },
      { id: 'r3', name: 'Classical FM',      frequency: '99.5 FM', url: 'https://ice1.somafm.com/defcon-128-mp3', color: '#9b59b6', description: '古典音乐精选', category: 'music-classical' },
      { id: 'r4', name: 'Jazz & Blues',      frequency: '103.7 FM', url: 'https://ice1.somafm.com/groovesalad-128-mp3', color: '#e67e22', description: '爵士与布鲁斯', category: 'music-jazz' },
      { id: 'r5', name: 'Lofi Relax',        frequency: '107.3 FM', url: 'https://ice1.somafm.com/dronezone-128-mp3', color: '#27ae60', description: '放松环境音乐', category: 'music-lofi' },
    ],
    tv: [
      { id: 't1', name: 'NASA TV',           frequency: 'CH 01', url: 'https://www.nasa.gov/wp-content/themes/nasa/assets/video/nasa-tv-public_256k.mp4', color: '#e74c3c', description: 'NASA 公共频道', category: 'tv-documentary' },
      { id: 't2', name: 'Big Buck Bunny',    frequency: 'CH 03', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4', color: '#1abc9c', description: '开源动画短片', category: 'tv-movie' },
      { id: 't3', name: 'Sintel',            frequency: 'CH 07', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4', color: '#9b59b6', description: '开源动画电影', category: 'tv-movie' },
      { id: 't4', name: 'Tears of Steel',    frequency: 'CH 11', url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4', color: '#f39c12', description: '开源科幻短片', category: 'tv-educational' },
    ]
  };

  const CATEGORY_LABELS = {
    radio: {
      'all': '全部',
      'news': '新闻资讯',
      'music-classical': '古典',
      'music-jazz': '爵士',
      'music-pop': '流行',
      'music-lofi': 'Lo-Fi',
      'other': '其它'
    },
    tv: {
      'all': '全部',
      'tv-documentary': '纪录片',
      'tv-movie': '电影',
      'tv-educational': '教育',
      'other': '其它'
    }
  };

  /* -------------------- 全局状态 -------------------- */
  const STORAGE_KEY = 'retro_radio_tv_channels_v2';
  const DATA_VERSION_KEY = 'retro_radio_data_version';
  const CURRENT_DATA_VERSION = '8';
  let state = {
    channels: loadChannels(),
    activeDevice: 'radio',         // 'radio' | 'tv'
    activeCategory: { radio: 'all', tv: 'all', manager: 'all' },
    presetPage: { radio: 0, tv: 0 }, // 分类分页索引（5 列 × 2 行 = 10 个/页）
    treeExpanded: { radio: {}, tv: {} }, // 树形目录展开状态
    current: { radio: null, tv: null }, // 当前选中频道id
    playing: { radio: false, tv: false },
    power: { radio: false, tv: false },
    volume: { radio: 50, tv: 50 },
    knobAngle: { tune: 0, vol: 0, bass: 0, mid: 0, treble: 0, tvCh: 0, tvVol: 0, tvFine: 0 },
    eq: { bass: 0, mid: 0, treble: 0 },
    currentTab: 'radio',
    counter: {
      seconds: 0,
      intervalId: null
    },
    // Web Audio 相关节点
    audio: {
      ctx: null,
      source: null,
      splitter: null,
      merger: null,
      leftGain: null,
      rightGain: null,
      masterGain: null,
      lowPass: null,          // 模拟老式喇叭的低通滤波
      leftAnalyser: null,
      rightAnalyser: null,
      noiseSrc: null,         // 白噪声源（调谐沙沙声）
      noiseFilter: null,      // 噪声低通
      noiseGain: null,        // 噪声音量
      noiseLeftGain: null,    // 噪声左声道
      noiseRightGain: null,   // 噪声右声道
      hissNode: null,         // 静态白噪声（播放时的底噪）
      hissGain: null,
      analyser: null,         // 可视化分析器
      rafId: null,            // 动画帧ID
      tuned: 1.0,             // 调谐质量 0~1 (1=最清晰)
      vizEffect: 'classic',    // 当前 VU 表样式: classic | black | round
      vizBarsLeft: null,      // 左声道条形DOM数组
      vizBarsRight: null,     // 右声道条形DOM数组
      vizWaveLeft: null,      // 左声道波形canvas
      vizWaveRight: null,     // 右声道波形canvas
      vizLedLeft: null,       // 左声道LED DOM数组
      vizLedRight: null,     // 右声道LED DOM数组
      vizEqLeft: null,        // 左声道均衡器条
      vizEqRight: null,       // 右声道均衡器条
      vizCircleLeft: null,
      vizCircleRight: null,
      spkBarsLeft: null,       // 左扬声器频谱柱
      spkBarsRight: null,      // 右扬声器频谱柱
      smoothLeftRMS: 0,        // 平滑后的左RMS
      smoothRightRMS: 0        // 平滑后的右RMS
    }
  };

  function loadChannels() {
    try {
      if (typeof CHANNEL_DATA !== 'undefined' && CHANNEL_DATA.radio && CHANNEL_DATA.tv) {
        const processed = processChannels(CHANNEL_DATA);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(processed));
        return processed;
      }
    } catch (e) {
      console.warn('处理频道数据失败', e);
    }
    
    return JSON.parse(JSON.stringify(DEFAULT_CHANNELS));
  }

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
      {name:'爵士FM',           frequency:'FM99.1', url:'http://lhttp.qtfm.cn/live/20207764/64k.mp3', region:'海外', category:'音乐'},
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
      {name:'四川',       kw:['四川', '成都', '天府', '岷江', '绵阳', '德阳', '南充', '达州', '遂宁', '内江', '乐山', '自贡', '泸州', '宜宾', '广安', '广元', '眉山', '资阳', '巴中', '雅安', '攀枝花', '凉山', '甘孜', '阿坝', '新都', '郫都', '双流', '温江', '龙泉', '新津', '崇州', '彭州', '都江堰', '邛崃', '大邑', '蒲江', '青白江', '金堂', '什邡', '绵竹', '广汉', '江油', '三台', '射洪', '中江', '南部', '阆中', '西充', '仪陇', '营山', '蓬安', '富顺', '荣县', '泸县', '合江', '叙永', '古蔺', '江安', '长宁', '高县', '珙县', '筠连', '兴文', '屏山', '广安', '华蓥', '岳池', '武胜', '邻水', '苍溪', '旺苍', '剑阁', '青川', '仁寿', '洪雅', '丹棱', '彭山', '安岳', '乐至', '平昌', '通江', '南江', '名山', '荥经', '汉源', '石棉', '天全', '芦山', '宝兴', '米易', '盐边', '西昌']},
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
    
    const urlSeen = new Set();
    const nameSeen = new Set();
    const uniqueRadio = [];
    let urlDuplicates = 0;
    let nameDuplicates = 0;
    for (let i = 0; i < radio.length; i++) {
      const r = radio[i];
      if (urlSeen.has(r.url)) {
        urlDuplicates++;
        continue;
      }
      urlSeen.add(r.url);
      const isThirdParty = r.url.includes('qingting') || r.url.includes('xmcdn') || r.url.includes('qtfm') || r.url.includes('ximalaya');
      if (nameSeen.has(r.name) && isThirdParty) {
        nameDuplicates++;
        continue;
      }
      nameSeen.add(r.name);
      uniqueRadio.push(r);
    }
    console.log('去重统计 - 原始数量:', radio.length, ', 去重后:', uniqueRadio.length, ', URL重复:', urlDuplicates, ', 名称重复(第三方):', nameDuplicates);
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
  function saveChannels() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.channels));
    } catch (e) { console.warn('保存频道失败', e); }
  }

  /* ==================== Web Audio: 左右声道分离 & 动态音效 ==================== */

  // 生成白噪声 buffer（几秒循环）
  function createNoiseBuffer(ctx, seconds) {
    const len = ctx.sampleRate * seconds;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.35;
    }
    return buf;
  }

  // 初始化音频节点图（懒加载：首次播放时调用）
  // 信号流:
  //   HTMLAudioElement -> splitter(2)
  //     ├── output 0 (leftGain → leftAnalyser → merger input 0
  //     └── output 1 (右) → rightGain → rightAnalyser → merger input 1
  //                          merger → masterGain → destination
  //   噪声: noiseSrc → bandpassFilter → noiseGain
  //                         noiseGain → noiseRightGain → merger 输入 1
  //   hiss底噪: hissSrc → highpass → hissGain → masterGain
  function ensureRadioAudioGraph() {
    const A = state.audio;
    
    if (A.ctx && A.leftAnalyser && A.rightAnalyser && A.analyser) {
      return true;
    }

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return false;
      A.ctx = new AudioCtx();
      const ctx = A.ctx;

      A.leftAnalyser = ctx.createAnalyser();
      A.leftAnalyser.fftSize = 1024;
      A.leftAnalyser.smoothingTimeConstant = 0.82;
      A.rightAnalyser = ctx.createAnalyser();
      A.rightAnalyser.fftSize = 1024;
      A.rightAnalyser.smoothingTimeConstant = 0.82;

      A.analyser = ctx.createAnalyser();
      A.analyser.fftSize = 256;

      A.splitter = ctx.createChannelSplitter(2);
      A.splitter.connect(A.leftAnalyser, 0);
      A.splitter.connect(A.rightAnalyser, 1);
      
      A.destination = ctx.destination;

      // ========== 调谐"沙沙声"：独立白噪声路由 ==========
      A.noiseSrc = ctx.createBufferSource();
      A.noiseSrc.buffer = createNoiseBuffer(ctx, 4);
      A.noiseSrc.loop = true;

      A.noiseFilter = ctx.createBiquadFilter();
      A.noiseFilter.type = 'bandpass';
      A.noiseFilter.frequency.value = 2000;
      A.noiseFilter.Q.value = 1.2;

      A.noiseGain = ctx.createGain();
      A.noiseGain.gain.value = 0; // 初始静音

      A.noiseLeftGain = ctx.createGain();
      A.noiseLeftGain.gain.value = 1.0;
      A.noiseRightGain = ctx.createGain();
      A.noiseRightGain.gain.value = 1.0;

      A.noiseSrc.connect(A.noiseFilter);
      A.noiseFilter.connect(A.noiseGain);
      A.noiseGain.connect(A.noiseLeftGain);
      A.noiseGain.connect(A.noiseRightGain);
      A.noiseLeftGain.connect(A.merger, 0, 0);   // 噪声 -> 左声道
      A.noiseRightGain.connect(A.merger, 0, 1);  // 噪声 -> 右声道
      A.noiseSrc.start();

      // ========== 播放时的轻微"磁带底噪"（hiss） ==========
      A.hissNode = ctx.createBufferSource();
      A.hissNode.buffer = createNoiseBuffer(ctx, 5);
      A.hissNode.loop = true;

      const hissFilter = ctx.createBiquadFilter();
      hissFilter.type = 'highpass';
      hissFilter.frequency.value = 3500;

      A.hissGain = ctx.createGain();
      A.hissGain.gain.value = 0; // 播放时才激活

      A.hissNode.connect(hissFilter);
      hissFilter.connect(A.hissGain);
      A.hissGain.connect(A.masterGain);  // 底噪走 master
      A.hissNode.start();

      return true;
    } catch (err) {
      console.warn('Web Audio 初始化失败', err);
      return false;
    }
  }

  // 启动/关闭动态音效循环
  function startRadioDynamics() {
    const A = state.audio;
    if (!A.ctx) return;
    if (A.ctx.state === 'suspended') A.ctx.resume();

    // 激活底噪 (轻微 hiss)
    if (A.hissGain) {
      A.hissGain.gain.cancelScheduledValues(A.ctx.currentTime);
      A.hissGain.gain.setTargetAtTime(0.04, A.ctx.currentTime, 0.1);
    }
    // 启动动态循环
    if (A.rafId) cancelAnimationFrame(A.rafId);
    animateRadio();
  }

  function stopRadioDynamics() {
    const A = state.audio;
    if (!A.ctx) return;
    // 关底噪
    if (A.hissGain) {
      A.hissGain.gain.cancelScheduledValues(A.ctx.currentTime);
      A.hissGain.gain.setTargetAtTime(0, A.ctx.currentTime, 0.1);
    }
    // 关闭调谐噪声
    if (A.noiseGain) {
      A.noiseGain.gain.cancelScheduledValues(A.ctx.currentTime);
      A.noiseGain.gain.setTargetAtTime(0, A.ctx.currentTime, 0.05);
    }
    // 恢复左右声道平衡
    if (A.leftGain && A.rightGain) {
      A.leftGain.gain.setTargetAtTime(1.0, A.ctx.currentTime, 0.1);
      A.rightGain.gain.setTargetAtTime(1.0, A.ctx.currentTime, 0.1);
    }
    if (A.rafId) {
      cancelAnimationFrame(A.rafId);
      A.rafId = null;
    }
  }

  // 播放时动态循环：调谐噪声、底噪、以及基于真实左右声道能量驱动扬声器视觉
  function animateRadio() {
    const A = state.audio;
    if (!A.ctx || !A.leftAnalyser || !A.rightAnalyser) {
      console.warn('animateRadio: 音频节点未就绪');
      return;
    }

    let tick = 0;

    const loop = () => {
      tick++;

      // --- 调谐噪声与 hiss 随 tuned 变化 ---
      const detune = 1.0 - A.tuned;

      if (A.noiseGain) {
        const noiseTarget = 0.02 + detune * 0.25;
        A.noiseGain.gain.setTargetAtTime(noiseTarget, A.ctx.currentTime, 0.08);
      }

      // hiss 底噪在播放期间保持轻微恒定（不随 tuned 变化）
      if (A.hissGain) {
        A.hissGain.gain.setTargetAtTime(0.03, A.ctx.currentTime, 0.1);
      }

      // --- 动态低通：未对准更闷 ---
      if (A.lowPass) {
        const freq = 3000 + A.tuned * 4000;
        A.lowPass.frequency.setTargetAtTime(freq, A.ctx.currentTime, 0.1);
      }

      // --- 左右扬声器视觉更新（每帧更新一次，取实际左右声道能量） ---
      updateSpeakerVisuals();

      A.rafId = requestAnimationFrame(loop);
    };
    A.rafId = requestAnimationFrame(loop);
  }

  /* ==================== 可视化效果系统 ==================== */

  // 初始化可视化 DOM 元素（彩条 / LED / 波形canvas / 圆形canvas / 扬声器频谱）
  function initVizElements() {
    const A = state.audio;
    const NUM_BARS = 16;
    const NUM_LEDS = 20; // 5x4 LED网格

    // ---- 扬声器 LED 氛围灯条（每边 64 段）----
    const NUM_SPK_LEDS = 64;
    // HSL 彩虹色生成：底部(index 0)蓝色 -> 顶部(index 63)红色
    const getLedColor = (index, total, hueShift = 0) => {
      const t = index / (total - 1); // 0..1
      // 色相：240(蓝) -> 0(红)，经过青绿黄橙
      const hue = 240 - t * 240 + hueShift;
      const sat = 90 + t * 10; // 90% -> 100%
      const light = 45 + Math.sin(t * Math.PI) * 15; // 中间亮两头暗
      return { hue, sat, light };
    };
    const buildLedStrip = (containerEl, hueShift = 0) => {
      if (!containerEl) return [];
      containerEl.innerHTML = '';
      const segs = [];
      for (let i = 0; i < NUM_SPK_LEDS; i++) {
        const seg = document.createElement('div');
        seg.className = 'led-seg';
        const c = getLedColor(i, NUM_SPK_LEDS, hueShift);
        seg.style.background = `hsl(${c.hue}, ${c.sat}%, ${c.light}%)`;
        seg.dataset.hue = c.hue;
        seg.dataset.sat = c.sat;
        seg.dataset.light = c.light;
        containerEl.appendChild(seg);
        segs.push(seg);
      }
      return segs;
    };
    A.spkBarsLeft = buildLedStrip(document.querySelector('.speaker-left .speaker-spectrum-bar'), 0);
    A.spkBarsRight = buildLedStrip(document.querySelector('.speaker-right .speaker-spectrum-bar'), 15);

    // ---- VU 电平表刻度初始化 ----
    document.querySelectorAll('.vu-tick').forEach(tick => {
      const angle = tick.dataset.angle;
      tick.style.setProperty('--angle', angle + 'deg');
    });

    // ---- 彩条 ----
    ['Left', 'Right'].forEach(side => {
      const containerId = side === 'Left' ? 'vizLeftBars' : 'vizRightBars';
      const container = document.getElementById(containerId);
      if (!container) return;
      const bars = [];
      for (let i = 0; i < NUM_BARS; i++) {
        const bar = document.createElement('div');
        bar.className = 'viz-bar';
        bar.style.height = '2px';
        container.appendChild(bar);
        bars.push(bar);
      }
      if (side === 'Left') A.vizBarsLeft = bars;
      else A.vizBarsRight = bars;
    });

    // ---- LED点阵 ----
    ['Left', 'Right'].forEach(side => {
      const containerId = side === 'Left' ? 'vizLeftLed' : 'vizRightLed';
      const container = document.getElementById(containerId);
      if (!container) return;
      const leds = [];
      for (let i = 0; i < NUM_LEDS; i++) {
        const led = document.createElement('div');
        led.className = 'viz-led off';
        container.appendChild(led);
        leds.push(led);
      }
      if (side === 'Left') A.vizLedLeft = leds;
      else A.vizLedRight = leds;
    });

    // ---- 波形canvas ----
    ['Left', 'Right'].forEach(side => {
      const containerId = side === 'Left' ? 'vizLeftWave' : 'vizRightWave';
      const container = document.getElementById(containerId);
      if (!container) return;
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 60;
      container.appendChild(canvas);
      if (side === 'Left') A.vizWaveLeft = canvas;
      else A.vizWaveRight = canvas;
    });

    // ---- 圆形canvas ----
    ['Left', 'Right'].forEach(side => {
      const containerId = side === 'Left' ? 'vizLeftCircle' : 'vizRightCircle';
      const container = document.getElementById(containerId);
      if (!container) return;
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 200;
      container.appendChild(canvas);
      if (side === 'Left') A.vizCircleLeft = canvas;
      else A.vizCircleRight = canvas;
    });

    // ---- 中央 LED 频谱条（20 段，左右声道各一组）----
    const NUM_CENTER_LEDS = 20;
    const buildCenterLed = (containerEl, isRight) => {
      if (!containerEl) return [];
      const segs = [];
      for (let i = 0; i < NUM_CENTER_LEDS; i++) {
        const seg = document.createElement('div');
        seg.className = 'led-seg-c';
        const t = i / (NUM_CENTER_LEDS - 1);
        // 左：绿->黄->红；右：青->天蓝->品红
        const hue = isRight ? 200 - t * 180 : 120 - t * 120;
        seg.style.background = `hsl(${hue}, 95%, 55%)`;
        seg.style.boxShadow = `0 0 3px hsl(${hue}, 95%, 55%)`;
        seg.style.opacity = '0.15';
        containerEl.appendChild(seg);
        segs.push(seg);
      }
      return segs;
    };
    A.vizLedLeft = buildCenterLed(document.getElementById('vizLeftLed'), false);
    A.vizLedRight = buildCenterLed(document.getElementById('vizRightLed'), true);

    // ---- 波形 canvas ----
    ['Left', 'Right'].forEach(side => {
      const containerId = side === 'Left' ? 'vizLeftWave' : 'vizRightWave';
      const container = document.getElementById(containerId);
      if (!container) return;
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 80;
      container.appendChild(canvas);
      if (side === 'Left') A.vizWaveLeft = canvas;
      else A.vizWaveRight = canvas;
    });

    // ---- 圆形 canvas（含内层）----
    ['Left', 'Right'].forEach(side => {
      const containerId = side === 'Left' ? 'vizLeftCircle' : 'vizRightCircle';
      const container = document.getElementById(containerId);
      if (!container) return;
      const inner = document.createElement('div');
      inner.className = 'viz-circle-inner';
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 160;
      inner.appendChild(canvas);
      const center = document.createElement('div');
      center.className = 'viz-circle-center';
      inner.appendChild(center);
      container.appendChild(inner);
      if (side === 'Left') A.vizCircleLeft = canvas;
      else A.vizCircleRight = canvas;
    });

    // ---- 均衡器（10 段）----
    ['Left', 'Right'].forEach(side => {
      const containerId = side === 'Left' ? 'vizLeftEq' : 'vizRightEq';
      const container = document.getElementById(containerId);
      if (!container) return;
      const bars = [];
      for (let i = 0; i < 10; i++) {
        const bar = document.createElement('div');
        bar.className = 'viz-eq-bar';
        bar.style.height = '5%';
        container.appendChild(bar);
        bars.push(bar);
      }
      if (side === 'Left') A.vizEqLeft = bars;
      else A.vizEqRight = bars;
    });

    applyVizEffect(A.vizEffect || 'classic');
    
    updateClock();
    setInterval(updateClock, 1000);
  }
  
  function updateClock() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    
    const hourDeg = (hours % 12) * 30 + minutes * 0.5;
    const minuteDeg = minutes * 6;
    const secondDeg = seconds * 6;
    
    const hourEl = document.getElementById('clockHour');
    const minuteEl = document.getElementById('clockMinute');
    const secondEl = document.getElementById('clockSecond');
    
    if (hourEl) hourEl.style.transform = `rotate(${hourDeg}deg)`;
    if (minuteEl) minuteEl.style.transform = `rotate(${minuteDeg}deg)`;
    if (secondEl) secondEl.style.transform = `rotate(${secondDeg}deg)`;
  }

  // 切换 VU 表样式（在 .viz-panel 上设置 data-active-style，并高亮按钮）
  function applyVizEffect(effect) {
    const A = state.audio;
    A.vizEffect = effect;
    const panel = document.getElementById('vizPanel');
    if (panel) panel.setAttribute('data-active-style', effect);
    document.querySelectorAll('.viz-style-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.style === effect);
    });
  }

  // 样式切换按钮事件绑定
  function bindVizButtons() {
    document.querySelectorAll('.viz-style-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const effect = btn.dataset.style;
        if (effect) applyVizEffect(effect);
      });
    });
  }

  // ==================== 核心：左右声道可视化渲染 ====================
  function updateSpeakerVisuals() {
    const A = state.audio;
    if (!A.leftAnalyser || !A.rightAnalyser) return;
    if (!A.spkBarsLeft) return; // 扬声器 LED 条未初始化则跳过

    const effect = A.vizEffect;

    // ---- 从左右 Analyser 读取频域数据 ----
    const getFreqData = (analyser) => {
      const bufLen = analyser.frequencyBinCount;
      const data = new Uint8Array(bufLen);
      analyser.getByteFrequencyData(data);
      return { data, bufLen };
    };
    const leftFreq = getFreqData(A.leftAnalyser);
    const rightFreq = getFreqData(A.rightAnalyser);

    // 频域平均能量（比时域 RMS 更稳定、更贴近听感）
    // 低频加权更高（人声/音乐的主体），高频稍降
    const getAvgFreqEnergy = (freqData) => {
      const { data, bufLen } = freqData;
      const mid = Math.floor(bufLen * 0.5); // 只用前 50% 频段（更贴近真实音乐能量）
      let sum = 0;
      let weightSum = 0;
      for (let i = 0; i < mid; i++) {
        const w = 1.0 - (i / mid) * 0.55; // 低频权重更高
        sum += data[i] * w;
        weightSum += w;
      }
      // 归一化到 0-1
      return (sum / weightSum) / 255;
    };
    const leftRMS = getAvgFreqEnergy(leftFreq);
    let rightRMS = getAvgFreqEnergy(rightFreq);
    
    if (rightRMS < 0.01 && leftRMS > 0.01) {
      rightRMS = leftRMS;
    }

    const tunedFactor = A.tuned * 0.85 + 0.15;
    const volFactor = Math.max(0.05, state.volume.radio / 100);
    // 减小整体放大倍数，避免小声音就跳到 100%
    const totalLeft = leftRMS * volFactor * 2.5;
    const totalRight = rightRMS * volFactor * 2.5;

    const SMOOTH_UP = 0.25;
    const SMOOTH_DOWN = 0.55;
    const rawLeft = Math.min(1, totalLeft);
    const rawRight = Math.min(1, totalRight);

    if (rawLeft > A.smoothLeftRMS) {
      A.smoothLeftRMS = A.smoothLeftRMS * SMOOTH_UP + rawLeft * (1 - SMOOTH_UP);
    } else {
      A.smoothLeftRMS = A.smoothLeftRMS * SMOOTH_DOWN + rawLeft * (1 - SMOOTH_DOWN);
    }
    if (rawRight > A.smoothRightRMS) {
      A.smoothRightRMS = A.smoothRightRMS * SMOOTH_UP + rawRight * (1 - SMOOTH_UP);
    } else {
      A.smoothRightRMS = A.smoothRightRMS * SMOOTH_DOWN + rawRight * (1 - SMOOTH_DOWN);
    }

    // 渲染 LED 条：根据能量从底部（index 0）往上点亮
    // energy 0 → 0段；energy 1 → 64段全亮；给一点响应曲线让视觉更自然
    const renderLedStrip = (segments, smoothRMS, tunedFactor) => {
      if (!segments || !segments.length) return;
      const effective = smoothRMS * tunedFactor;
      // 能量曲线：低值更柔和，强音时更冲
      const curved = Math.pow(Math.max(0, Math.min(1, effective)), 0.85);
      const totalLeds = segments.length;
      // 要点亮的段数：用浮点计算，让顶部一段可以"半亮"
      const exactCount = curved * totalLeds;
      const lightCount = Math.floor(exactCount);
      const topIntensity = exactCount - lightCount;
      for (let i = 0; i < totalLeds; i++) {
        const seg = segments[i];
        const hue = seg.dataset.hue || 0;
        const sat = seg.dataset.sat || 90;
        const baseLight = seg.dataset.light || 50;
        if (i < lightCount) {
          seg.classList.add('on');
          seg.style.opacity = '1';
          // 点亮时增加亮度和发光
          const glowLight = Math.min(70, parseFloat(baseLight) + 20);
          seg.style.background = `hsl(${hue}, ${sat}%, ${glowLight}%)`;
          seg.style.boxShadow = `0 0 3px hsl(${hue}, ${sat}%, ${glowLight}%)`;
        } else if (i === lightCount && topIntensity > 0.1) {
          // 顶部一段：半亮状态，平滑过渡
          seg.classList.add('on');
          const op = 0.3 + topIntensity * 0.7;
          seg.style.opacity = op.toFixed(2);
          const glowLight = Math.min(70, parseFloat(baseLight) + 10);
          seg.style.background = `hsl(${hue}, ${sat}%, ${glowLight}%)`;
          seg.style.boxShadow = `0 0 2px hsl(${hue}, ${sat}%, ${glowLight}%)`;
        } else {
          seg.classList.remove('on');
          seg.style.opacity = '';
          seg.style.background = `hsl(${hue}, ${sat}%, ${baseLight}%)`;
          seg.style.boxShadow = '';
        }
      }
      // 容器显隐（整组激活）
      const wrap = segments[0].parentElement;
      if (wrap) wrap.classList.toggle('speaker-active', smoothRMS > 0.015);
    };
    renderLedStrip(A.spkBarsLeft, A.smoothLeftRMS, tunedFactor);
    renderLedStrip(A.spkBarsRight, A.smoothRightRMS, tunedFactor);

    // 扬声器网格发光：与 LED 条同色系的脉动发光
    const leftEl = document.querySelector('.speaker-left .speaker-grille');
    const rightEl = document.querySelector('.speaker-right .speaker-grille');
    if (leftEl) {
      leftEl.style.boxShadow = `inset 0 0 30px rgba(0,0,0,0.7), 0 0 ${4 + A.smoothLeftRMS * 32}px rgba(255,120,80,${0.2 + A.smoothLeftRMS * 0.45})`;
      leftEl.style.opacity = (0.85 + A.smoothLeftRMS * 0.15).toFixed(3);
    }
    if (rightEl) {
      rightEl.style.boxShadow = `inset 0 0 30px rgba(0,0,0,0.7), 0 0 ${4 + A.smoothRightRMS * 32}px rgba(100,200,255,${0.2 + A.smoothRightRMS * 0.45})`;
      rightEl.style.opacity = (0.85 + A.smoothRightRMS * 0.15).toFixed(3);
    }

    // ==== 中央 VU 电平表：根据样式渲染对应指针 ====
    renderVU(A, leftRMS, rightRMS, tunedFactor, volFactor, effect);
  }

  // ---- VU 电平表渲染（三种样式：classic / black / round）----
  function renderVU(A, leftRMS, rightRMS, tunedFactor, volFactor, style) {
    style = style || 'classic';
    const vf = Math.max(0.1, volFactor || 1);
    // 减小总放大倍数，响应曲线改为更线性，避免小声音就跳到满
    const leftEnergy = Math.min(1, leftRMS * tunedFactor * vf * 1.8);
    const rightEnergy = Math.min(1, rightRMS * tunedFactor * vf * 1.8);
    let minA = -78, maxA = 78;
    const range = maxA - minA;
    // 用 0.7 幂次曲线（比 0.55 更接近线性），让指针移动更可控
    const leftAngle = minA + Math.pow(leftEnergy, 0.7) * range;
    const rightAngle = minA + Math.pow(rightEnergy, 0.7) * range;
    const needleIds = ['vuNeedleLeft', 'vuNeedleLeftBlack', 'vuNeedleLeftRound'];
    const needleIdsR = ['vuNeedleRight', 'vuNeedleRightBlack', 'vuNeedleRightRound'];
    needleIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.transform = `translateX(-50%) rotate(${leftAngle.toFixed(1)}deg)`;
    });
    needleIdsR.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.transform = `translateX(-50%) rotate(${rightAngle.toFixed(1)}deg)`;
    });
  }

  // ---- 中央 LED 频谱条渲染（随能量从底部点亮）----
  function renderCenterLed(A, leftEnergy, rightEnergy) {
    const renderOne = (segments, energy) => {
      if (!segments || !segments.length) return;
      const curved = Math.pow(Math.max(0, Math.min(1, energy)), 0.75);
      const total = segments.length;
      const exactCount = curved * total;
      const lightCount = Math.floor(exactCount);
      const topIntensity = exactCount - lightCount;
      for (let i = 0; i < total; i++) {
        const seg = segments[i];
        if (i < lightCount) {
          seg.style.opacity = '1';
        } else if (i === lightCount && topIntensity > 0.1) {
          seg.style.opacity = (0.2 + topIntensity * 0.8).toFixed(2);
        } else {
          seg.style.opacity = '0.15';
        }
      }
    };
    renderOne(A.vizLedLeft, leftEnergy);
    renderOne(A.vizLedRight, rightEnergy);
  }

  // ---- 1. 彩条渲染 ----
  function renderBars(A, leftFreq, rightFreq, tunedFactor) {
    const numBars = A.vizBarsLeft.length;
    const step = Math.floor(leftFreq.bufLen / numBars);

    for (let i = 0; i < numBars; i++) {
      const li = Math.min(leftFreq.bufLen - 1, i * step);
      const ri = Math.min(rightFreq.bufLen - 1, i * step);
      const lVal = (leftFreq.data[li] / 255) * tunedFactor;
      const rVal = (rightFreq.data[ri] / 255) * tunedFactor;
      const h = Math.max(2, Math.round(lVal * 100));
      const rh = Math.max(2, Math.round(rVal * 100));
      A.vizBarsLeft[i].style.height = h + '%';
      A.vizBarsRight[i].style.height = rh + '%';
    }
  }

  // ---- 2. 波形渲染 ----
  function renderWaveform(A, leftRMS, rightRMS, tunedFactor) {
    const drawWave = (canvas, rms, tunedFactor, color) => {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.shadowBlur = 8;
      ctx.shadowColor = color;
      ctx.beginPath();
      const amp = Math.min(1, rms * 3 * tunedFactor) * (h / 2 - 4);
      for (let x = 0; x < w; x++) {
        const t = (x / w) * Math.PI * 8;
        const y = h / 2 + Math.sin(t) * amp * 0.6 + Math.sin(t * 1.7) * amp * 0.3;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // 中心线
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
    };
    drawWave(A.vizWaveLeft, leftRMS, tunedFactor, '#ff44cc');
    drawWave(A.vizWaveRight, rightRMS, tunedFactor, '#44ccff');
  }

  // ---- 3. 圆形渲染 ----
  function renderCircle(A, leftFreq, leftRMS, rightFreq, rightRMS, tunedFactor) {
    const drawCircle = (canvas, freqData, rms, tunedFactor, color) => {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      const cx = w / 2, cy = h / 2;
      const baseR = Math.min(w, h) / 2 * 0.55;
      ctx.clearRect(0, 0, w, h);

      // 绘制环形频谱
      const bars = 64;
      for (let i = 0; i < bars; i++) {
        const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
        const freqIdx = Math.floor((i / bars) * freqData.bufLen * 0.7);
        const val = (freqData.data[freqIdx] / 255) * tunedFactor;
        const r = baseR + val * baseR * 0.6;
        const x1 = cx + Math.cos(angle) * baseR;
        const y1 = cy + Math.sin(angle) * baseR;
        const x2 = cx + Math.cos(angle) * r;
        const y2 = cy + Math.sin(angle) * r;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.shadowBlur = 6;
        ctx.shadowColor = color;
        ctx.globalAlpha = 0.4 + val * 0.6;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    };
    drawCircle(A.vizCircleLeft, leftFreq, leftRMS, tunedFactor, '#ff44cc');
    drawCircle(A.vizCircleRight, rightFreq, rightRMS, tunedFactor, '#44ccff');
  }

  // ---- 4. LED 点阵渲染 ----
  function renderLED(A, leftFreq, rightFreq, tunedFactor) {
    const NUM_ROWS = 4, NUM_COLS = 5;
    const total = NUM_ROWS * NUM_COLS;
    const leftLeds = A.vizLedLeft, rightLeds = A.vizLedRight;

    const renderChannelLeds = (leds, freqData, tunedFactor) => {
      if (!leds) return;
      for (let i = 0; i < total; i++) {
        // 从下往上点亮（低音在下）
        const freqIdx = Math.floor((i / total) * freqData.bufLen * 0.6);
        const val = (freqData.data[freqIdx] / 255) * tunedFactor;
        // 该列的平均值
        const col = i % NUM_COLS;
        const colFreqIdx = Math.floor((col / NUM_COLS) * freqData.bufLen * 0.6);
        const colVal = (freqData.data[colFreqIdx] / 255) * tunedFactor;
        const on = val > 0.35 || colVal > 0.45;
        leds[i].className = 'viz-led ' + (on ? 'on' : 'off');
      }
    };
    renderChannelLeds(leftLeds, leftFreq, tunedFactor);
    renderChannelLeds(rightLeds, rightFreq, tunedFactor);
  }

  // ---- 5. 经典均衡器渲染 ----
  function renderEqualizer(A, leftFreq, rightFreq, tunedFactor) {
    const bands = [0.15, 0.35, 0.55, 0.75, 0.9]; // 低,中低,中,中高,高 的频率位置
    const renderChannelEq = (bars, freqData, tunedFactor) => {
      if (!bars) return;
      bands.forEach((pos, i) => {
        const idx = Math.floor(pos * freqData.bufLen);
        const val = (freqData.data[idx] / 255) * tunedFactor;
        bars[i].style.height = Math.max(2, Math.round(val * 100)) + '%';
      });
    };
    renderChannelEq(A.vizEqLeft, leftFreq, tunedFactor);
    renderChannelEq(A.vizEqRight, rightFreq, tunedFactor);
  }

  // 切换到新频道时触发 "正在调谐" 的沙沙声动画
  function triggerTuningEffect(durationMs) {
    const A = state.audio;
    if (!A || !A.ctx) return;
    A.tuned = 0;
    const startT = performance.now();
    const tick = () => {
      const elapsed = performance.now() - startT;
      const p = Math.min(1, elapsed / (durationMs || 1200));
      // ease-out 曲线：快速上升，末尾收敛到 1
      A.tuned = 1 - Math.pow(1 - p, 2.5);
      if (p < 1) requestAnimationFrame(tick);
      else A.tuned = 1.0;
    };
    requestAnimationFrame(tick);
  }

  /* -------------------- DOM 引用 -------------------- */
  const $ = (id) => document.getElementById(id);

  const els = {
    // 设备切换
    deviceBtns: document.querySelectorAll('.device-btn[data-device]'),
    radioDevice: $('radioDevice'),
    tvDevice: $('tvDevice'),
    managerBtn: $('openManagerBtn'),

    // 收音机
    radioPowerSwitch: $('radioPowerSwitch'),
    tuneKnob: $('tuneKnob'),
    volumeKnob: $('volumeKnob'),
    bassKnob: $('bassKnob'),
    midKnob: $('midKnob'),
    trebleKnob: $('trebleKnob'),
    dialNeedle: $('dialNeedle'),
    radioChannelName: $('radioChannelName'),
    radioChannelFreq: $('radioChannelFreq'),
    radioPresets: $('radioPresets'),
    radioAudio: $('radioAudio'),
    radioAudioHLS: $('radioAudioHLS'),
    volumeHint: $('volumeHint'),
    bassHint: $('bassHint'),
    midHint: $('midHint'),
    trebleHint: $('trebleHint'),
    speakersRadio: document.querySelectorAll('#radioDevice .speaker'),
    counterDigits: $('counterDigits'),
    tapeLeft: $('tapeLeft'),
    tapeRight: $('tapeRight'),

    // 电视
    tvPowerBtn: $('tvPowerBtn'),
    tvPowerLight: $('tvPowerLight'),
    tvChKnob: $('tvChKnob'),
    tvVolKnob: $('tvVolKnob'),
    tvFineKnob: $('tvFineKnob'),
    tvVolHint: $('tvVolHint'),
    tvPresets: $('tvPresets'),
    tvVideo: $('tvVideo'),
    crtScreen: $('crtScreen'),
    tvChNum: $('tvChNum'),
    tvChName: $('tvChName'),

    // Modal
    channelModal: $('channelModal'),
    closeModalBtn: $('closeModalBtn'),
    editModal: $('editModal'),
    closeEditBtn: $('closeEditBtn'),
    addChannelBtn: $('addChannelBtn'),
    exportBtn: $('exportBtn'),
    importFile: $('importFile'),
    resetBtn: $('resetBtn'),
    channelTableBody: $('channelTableBody'),
    emptyHint: $('emptyHint'),
    tabBtns: document.querySelectorAll('.tab-btn'),
    editForm: $('editForm'),
    cancelEditBtn: $('cancelEditBtn'),
    editModalTitle: $('editModalTitle'),
    managerFilterTabs: $('managerFilterTabs'),

    toast: $('toast')
  };

  /* -------------------- 工具函数 -------------------- */
  function toast(msg, isError) {
    els.toast.textContent = msg;
    els.toast.classList.toggle('error', !!isError);
    els.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove('show'), 2400);
  }

  function generateId() {
    return 'ch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function getChannelsFor(type) {
    return state.channels[type] || [];
  }

  function getCurrentDeviceType() {
    return state.activeDevice;
  }

  /* -------------------- 设备切换 -------------------- */
  function switchDevice(device) {
    state.activeDevice = device;
    els.deviceBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.device === device);
    });
    els.radioDevice.classList.toggle('active', device === 'radio');
    els.tvDevice.classList.toggle('active', device === 'tv');
    if (device === 'radio') {
      stopPlaying('tv');
    } else {
      stopPlaying('radio');
    }
    renderPresets();
  }

  /* -------------------- 电源开关 -------------------- */
  function togglePower(device) {
    state.power[device] = !state.power[device];

    // 收音机拨动开关状态更新
    if (device === 'radio') {
      els.radioPowerSwitch.classList.toggle('on', state.power[device]);
      if (state.power[device]) {
        ensureRadioAudioGraph();
        if (state.audio.ctx && state.audio.ctx.state === 'suspended') {
          state.audio.ctx.resume().catch(() => {});
        }
      }
    } else {
      // 电视指示灯
      els.tvPowerLight.classList.toggle('on', state.power[device]);
    }

    if (!state.power[device]) {
      stopPlaying(device);
      if (device === 'radio') {
        resetCounter();
      }
    }

    if (device === 'tv' && state.power[device]) {
      playCrtOnAnimation();
    }
  }

  function playCrtOnAnimation() {
    els.crtScreen.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
    els.crtScreen.style.opacity = '0';
    els.crtScreen.style.transform = 'scaleY(0.02) scaleX(0.5)';
    setTimeout(() => {
      els.crtScreen.style.opacity = '1';
      els.crtScreen.style.transform = 'scaleY(1) scaleX(1)';
    }, 50);
    setTimeout(() => {
      els.crtScreen.style.transition = '';
      els.crtScreen.style.transform = '';
    }, 600);
  }

  /* -------------------- 旋钮旋转动画 -------------------- */
  function rotateKnob(el, angleDeg) {
    el.style.transform = `rotate(${angleDeg}deg)`;
  }

  /* -------------------- 收音机逻辑 -------------------- */
  function selectRadioChannel(channelId) {
    if (!state.power.radio) {
      toast('请先打开电源', true); return;
    }
    const channels = getChannelsFor('radio');
    const idx = channels.findIndex(c => c.id === channelId);
    if (idx === -1) return;
    state.current.radio = channelId;

    const ch = channels[idx];
    let posPercent = 50;
    const freq = ch.frequency || '';
    
    if (freq.startsWith('FM')) {
      const fmNum = parseFloat(freq.replace('FM', ''));
      if (!isNaN(fmNum) && fmNum >= 88 && fmNum <= 108) {
        posPercent = 15 + ((fmNum - 88) / (108 - 88)) * 70;
      }
    } else if (freq.startsWith('AM')) {
      const amNum = parseFloat(freq.replace('AM', ''));
      if (!isNaN(amNum) && amNum >= 540 && amNum <= 1600) {
        posPercent = 15 + ((amNum - 540) / (1600 - 540)) * 70;
      }
    } else {
      posPercent = channels.length <= 1 ? 50 : 15 + (idx / (channels.length - 1)) * 70;
    }
    
    els.dialNeedle.style.left = posPercent + '%';

    state.knobAngle.tune = -150 + (idx / Math.max(channels.length - 1, 1)) * 300;
    rotateKnob(els.tuneKnob, state.knobAngle.tune);

    els.radioChannelName.textContent = ch.name;
    els.radioChannelFreq.textContent = ch.frequency || ch.name;

    updateRadioSelection();
    triggerTuningEffect(1200);
    playAudio(ch.url, ch);
  }

  function playAudio(url, ch) {
    const audio = els.radioAudio;
    const hlsAudio = els.radioAudioHLS;
    
    if (!state.playSessionId) state.playSessionId = 0;
    const currentSessionId = ++state.playSessionId;
    
    try {
      if (state.audio.ctx && state.audio.ctx.state === 'suspended') {
        state.audio.ctx.resume();
      }
      
      audio.pause();
      audio.currentTime = 0;
      
      if (hlsAudio) {
        hlsAudio.pause();
        hlsAudio.currentTime = 0;
        if (hlsAudio.hlsObj) {
          try { hlsAudio.hlsObj.destroy(); } catch (e) {}
          hlsAudio.hlsObj = null;
        }
      }
      
      ensureRadioAudioGraph();
      
      if (url.toLowerCase().includes('.m3u8')) {
        if (hlsAudio && typeof Hls !== 'undefined' && Hls.isSupported()) {
          const hls = new Hls({
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
          
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (state.playSessionId !== currentSessionId) return;
            
            hlsAudio.volume = state.volume.radio / 100;
            
            state.playing.radio = true;
            els.speakersRadio.forEach(s => s.classList.add('playing'));
            startCounter();
            startTapeAnimation();
            
            hlsAudio.play().then(() => {
              if (state.playSessionId !== currentSessionId) return;
              
              if (state.audio.ctx) {
                state.audio.source = state.audio.ctx.createMediaElementSource(hlsAudio);
                state.audio.source.connect(state.audio.splitter);
                state.audio.source.connect(state.audio.ctx.destination);
              }
              startRadioDynamics();
            }).catch(err => {
              console.warn('HLS播放异常', err);
              if (state.playSessionId !== currentSessionId) return;
              if (hlsAudio.readyState >= 2) {
                if (state.audio.ctx) {
                  state.audio.source = state.audio.ctx.createMediaElementSource(hlsAudio);
                  state.audio.source.connect(state.audio.splitter);
                  state.audio.source.connect(state.audio.ctx.destination);
                }
                startRadioDynamics();
              } else {
                toast('无法播放该流', true);
                state.playing.radio = false;
                els.speakersRadio.forEach(s => s.classList.remove('playing'));
                stopCounter();
                stopTapeAnimation();
              }
            });
          });
          
          hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
              console.warn('HLS错误', data);
              toast('无法播放该流', true);
              state.playing.radio = false;
              els.speakersRadio.forEach(s => s.classList.remove('playing'));
              stopCounter();
              stopTapeAnimation();
            }
          });
          
          hls.loadSource(url);
          hls.attachMedia(hlsAudio);
          hlsAudio.hlsObj = hls;
        } else {
          audio.src = url;
          audio.volume = state.volume.radio / 100;
          
          state.playing.radio = true;
          els.speakersRadio.forEach(s => s.classList.add('playing'));
          startCounter();
          startTapeAnimation();
          
          const p = audio.play();
          if (p && p.catch) {
            p.then(() => {
              if (state.playSessionId !== currentSessionId) return;
              
              if (state.audio.ctx) {
                state.audio.source = state.audio.ctx.createMediaElementSource(audio);
                state.audio.source.connect(state.audio.splitter);
                state.audio.source.connect(state.audio.ctx.destination);
              }
              startRadioDynamics();
            }).catch(err => {
              console.warn('原生播放异常', err);
              if (state.playSessionId !== currentSessionId) return;
              if (audio.readyState >= 2) {
                if (state.audio.ctx) {
                  state.audio.source = state.audio.ctx.createMediaElementSource(audio);
                  state.audio.source.connect(state.audio.splitter);
                  state.audio.source.connect(state.audio.ctx.destination);
                }
                startRadioDynamics();
              } else {
                toast('浏览器不支持 HLS 格式', true);
                state.playing.radio = false;
                els.speakersRadio.forEach(s => s.classList.remove('playing'));
                stopCounter();
                stopTapeAnimation();
              }
            });
          }
        }
        return;
      }
      
      audio.src = url;
      audio.volume = state.volume.radio / 100;
      
      state.playing.radio = true;
      els.speakersRadio.forEach(s => s.classList.add('playing'));
      startCounter();
      startTapeAnimation();
      
      const p = audio.play();
      if (p && p.catch) {
        p.then(() => {
          if (state.playSessionId !== currentSessionId) return;
          
          if (state.audio.ctx) {
            state.audio.source = state.audio.ctx.createMediaElementSource(audio);
            state.audio.source.connect(state.audio.splitter);
            state.audio.source.connect(state.audio.ctx.destination);
          }
          startRadioDynamics();
        }).catch(err => {
          console.warn('播放异常', err);
          if (state.playSessionId !== currentSessionId) return;
          if (audio.readyState >= 2) {
            if (state.audio.ctx) {
              state.audio.source = state.audio.ctx.createMediaElementSource(audio);
              state.audio.source.connect(state.audio.splitter);
              state.audio.source.connect(state.audio.ctx.destination);
            }
            startRadioDynamics();
          } else {
            toast('无法播放该流（可能是跨域限制或URL无效）', true);
            state.playing.radio = false;
            els.speakersRadio.forEach(s => s.classList.remove('playing'));
            stopCounter();
            stopTapeAnimation();
          }
        });
      }
    } catch (e) {
      console.warn('音频播放错误', e);
      toast('音频播放错误', true);
    }
  }

  function fallbackToNativePlay(url) {
    const audio = els.radioAudio;
    try {
      const hlsAudio = els.radioAudioHLS;
      if (hlsAudio) {
        if (hlsAudio.hlsObj) { try { hlsAudio.hlsObj.destroy(); hlsAudio.hlsObj = null; } catch (e) {} }
        hlsAudio.pause();
        hlsAudio.currentTime = 0;
      }
      
      audio.src = url;
      audio.volume = 1.0;
      if (state.audio.masterGain) {
        state.audio.masterGain.gain.setTargetAtTime(
          state.volume.radio / 100,
          state.audio.ctx.currentTime,
          0.05
        );
      }
      audio.play().then(() => {
        state.playing.radio = true;
        els.speakersRadio.forEach(s => s.classList.add('playing'));
        startRadioDynamics();
        startCounter();
        startTapeAnimation();
      }).catch(err => {
        console.warn('原生播放失败', err);
        toast('该电台无法播放，请尝试其他电台', true);
        state.playing.radio = false;
        els.speakersRadio.forEach(s => s.classList.remove('playing'));
        stopRadioDynamics();
        stopCounter();
        stopTapeAnimation();
      });
    } catch (e) {
      console.warn('回退播放错误', e);
      toast('播放错误', true);
    }
  }

  function pauseRadio() {
    if (els.radioAudio) els.radioAudio.pause();
    if (els.radioAudioHLS) els.radioAudioHLS.pause();
    state.playing.radio = false;
    els.speakersRadio.forEach(s => s.classList.remove('playing'));
    stopRadioDynamics();
    stopCounter();
    stopTapeAnimation();
  }

  // 记录每个数字位上次的值，用于检测跳变滚动
  const lastCounterValues = [0, 0, 0, 0, 0, 0];
  // 记录每个位的定时器，避免多次 setTimeout 冲突
  const counterResetTimers = [null, null, null, null, null, null];

  function updateCounterDisplay(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    // 顺序: 时十位、时个位、分十位、分个位、秒十位、秒个位
    const digits = [
      Math.floor(hrs / 10),
      hrs % 10,
      Math.floor(mins / 10),
      mins % 10,
      Math.floor(secs / 10),
      secs % 10
    ];
    const digitContainers = els.counterDigits.querySelectorAll('.counter-digit');
    digitContainers.forEach((digitEl, idx) => {
      const strip = digitEl.querySelector('.digit-strip');
      const newVal = digits[idx];
      const oldVal = lastCounterValues[idx];

      // 清除该位上未完成的瞬移定时器
      if (counterResetTimers[idx]) {
        clearTimeout(counterResetTimers[idx]);
        counterResetTimers[idx] = null;
      }

      if (newVal === oldVal) {
        // 无变化，不动
        return;
      }

      if (newVal < oldVal) {
        // 数字变小（任何进位：9→0、5→0、3→0、2→0 等）
        // 滚到第 11 位（追加的 0），动画结束后瞬移回 newVal
        strip.style.transform = `translateY(-${10 * 30}px)`;
        counterResetTimers[idx] = setTimeout(() => {
          strip.style.transition = 'none';
          strip.style.transform = `translateY(-${newVal * 30}px)`;
          // 强制 reflow 后恢复过渡
          void strip.offsetWidth;
          strip.style.transition = '';
          counterResetTimers[idx] = null;
        }, 500);
      } else {
        // 正常递增滚动
        strip.style.transform = `translateY(-${newVal * 30}px)`;
      }

      lastCounterValues[idx] = newVal;
    });
  }

  function startCounter() {
    if (state.counter.intervalId) return;
    state.counter.intervalId = setInterval(() => {
      state.counter.seconds++;
      updateCounterDisplay(state.counter.seconds);
    }, 1000);
    updateCounterDisplay(state.counter.seconds);
  }

  function stopCounter() {
    if (state.counter.intervalId) {
      clearInterval(state.counter.intervalId);
      state.counter.intervalId = null;
    }
  }

  function resetCounter() {
    stopCounter();
    state.counter.seconds = 0;
    updateCounterDisplay(0);
  }

  function startTapeAnimation() {
    els.tapeLeft.classList.add('playing');
    els.tapeRight.classList.add('playing');
  }

  function stopTapeAnimation() {
    els.tapeLeft.classList.remove('playing');
    els.tapeRight.classList.remove('playing');
  }

  function toggleRadioPlay() {
    if (!state.power.radio) { toast('请先打开电源', true); return; }
    if (!state.current.radio) {
      // 没选过频道 -> 选第一个
      const channels = getChannelsFor('radio');
      if (channels.length) selectRadioChannel(channels[0].id);
      else toast('请先添加电台', true);
      return;
    }
    if (state.playing.radio) pauseRadio();
    else {
      const channels = getChannelsFor('radio');
      const ch = channels.find(c => c.id === state.current.radio);
      if (ch) playAudio(ch.url, ch);
    }
  }

  function stopPlaying(device) {
    if (device === 'radio') {
      pauseRadio();
    } else {
      els.tvVideo.pause();
      state.playing.tv = false;
      els.crtScreen.classList.remove('playing');
      els.tvChNum.textContent = state.current.tv ? '' : '';
    }
  }

  /* -------------------- 电视机逻辑 -------------------- */
  function selectTvChannel(channelId) {
    if (!state.power.tv) { toast('请先打开电源', true); return; }
    const channels = getChannelsFor('tv');
    const idx = channels.findIndex(c => c.id === channelId);
    if (idx === -1) return;
    state.current.tv = channelId;

    // 旋钮旋转
    state.knobAngle.tvCh = -150 + (idx / Math.max(channels.length - 1, 1)) * 300;
    rotateKnob(els.tvChKnob, state.knobAngle.tvCh);

    const ch = channels[idx];
    els.tvChNum.textContent = ch.frequency || `CH ${String(idx + 1).padStart(2, '0')}`;
    els.tvChName.textContent = ch.name;

    renderPresets();
    playVideo(ch.url, ch);
  }

  function playVideo(url, ch) {
    const v = els.tvVideo;
    v.pause();
    if (url.toLowerCase().includes('.m3u8')) {
      if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        if (v.hlsObj) { try { v.hlsObj.destroy(); } catch (e) {} }
        const hls = new Hls({
          fetchSetup: {
            mode: 'no-cors',
            credentials: 'include'
          }
        });
        hls.loadSource(url);
        hls.attachMedia(v);
        v.hlsObj = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          v.volume = state.volume.tv / 100;
          v.muted = false;
          v.play().catch(err => {
            console.warn('视频播放失败', err);
            toast('视频流无法播放', true);
          });
        });
        hls.on(Hls.Events.ERROR, (event, data) => {
          console.error('HLS 错误', data);
          if (data.fatal) {
            toast('HLS 流加载失败', true);
            state.playing.tv = false;
            els.crtScreen.classList.remove('playing');
          }
        });
        return;
      } else {
        v.src = url;
      }
    } else {
      if (v.hlsObj) { try { v.hlsObj.destroy(); v.hlsObj = null; } catch (e) {} }
      v.src = url;
    }
    v.volume = state.volume.tv / 100;
    v.muted = false;
    const p = v.play();
    if (p && p.catch) {
      p.then(() => {
        state.playing.tv = true;
        els.crtScreen.classList.add('playing');
      }).catch(err => {
        console.warn('视频播放失败', err);
        toast('视频流无法播放（可能是跨域或URL无效）', true);
        state.playing.tv = false;
        els.crtScreen.classList.remove('playing');
      });
    }
  }

  /* -------------------- 预设按钮渲染 -------------------- */
  function renderPresets() {
    try {
      _renderPresetPanel('radio', els.radioPresets, selectRadioChannel);
    } catch (e) {
      console.error('渲染收音机面板失败:', e);
    }
    try {
      _renderPresetPanel('tv', els.tvPresets, selectTvChannel);
    } catch (e) {
      console.error('渲染电视面板失败:', e);
    }
  }

  function updateRadioSelection() {
    const tabsEl = els.radioPresets.querySelector('.preset-tabs');
    if (!tabsEl) return;
    
    tabsEl.querySelectorAll('.tree-station').forEach(btn => {
      btn.classList.remove('active');
    });
    
    if (state.current.radio) {
      const activeBtn = tabsEl.querySelector('.tree-station[data-id="' + state.current.radio + '"]');
      if (activeBtn) {
        activeBtn.classList.add('active');
      }
    }
  }

  function normalizeStr(str) {
    return str.trim().replace(/[\uFEFF]/g, '').replace(/\s+/g, '').replace(/[\uFF01-\uFF5E]/g, function(c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  }

  function buildStationTree(list) {
    const regionGroups = {};
    
    list.forEach(station => {
      const region = station.description || '其它';
      if (!regionGroups[region]) {
        regionGroups[region] = [];
      }
      regionGroups[region].push(station);
    });

    const tree = [];

    for (const regionName of Object.keys(regionGroups)) {
      const stations = regionGroups[regionName];
      tree.push({
        type: 'region',
        name: regionName,
        children: stations.map(s => ({
          type: 'station',
          data: s
        }))
      });
    }

    tree.sort((a, b) => {
      const order = ['中央', '全国', '电视伴音', '国际', '香港', '澳门', '台湾', '海外'];
      const idxA = order.indexOf(a.name);
      const idxB = order.indexOf(b.name);
      if (idxA !== idxB) return idxA - idxB;
      return a.name.localeCompare(b.name, 'zh-CN');
    });

    return tree;
  }
  
  function _renderPresetPanel(type, panelEl, onSelect) {
    const list = getChannelsFor(type);
    
    if (type === 'radio') {
      const tree = buildStationTree(list);
      
      const tabsEl = panelEl.querySelector('.preset-tabs');
      const chEl = panelEl.querySelector('.preset-channels');
      
      if (tabsEl) {
        let targetRegion = null;
        const scrollTop = tabsEl.scrollTop;
        
        if (state.current[type]) {
          const currentStation = list.find(s => s.id === state.current[type]);
          if (currentStation) {
            targetRegion = currentStation.description;
          }
        }

        tabsEl.innerHTML = '';
        tabsEl.style.display = 'block';
        tabsEl.style.minHeight = 'auto';
        tabsEl.style.gap = '0';

        const treeContainer = document.createElement('div');
        treeContainer.className = 'station-tree';
        tabsEl.appendChild(treeContainer);

        tree.forEach(regionNode => {
          const regionName = regionNode.name;
          const isTargetRegion = regionName === targetRegion;
          const isExpanded = isTargetRegion || (state.treeExpanded[type][regionName] === true);
          
          const regionBtn = document.createElement('button');
          regionBtn.className = 'tree-header tree-header-region';
          regionBtn.innerHTML = (isExpanded ? '▼' : '▶') + ' ' + regionName + ' · ' + regionNode.children.length;
          regionBtn.style.paddingLeft = '8px';
          
          const regionContent = document.createElement('div');
          regionContent.className = 'tree-children';
          regionContent.style.display = isExpanded ? 'block' : 'none';
          
          regionNode.children.forEach(stationNode => {
            const stationBtn = document.createElement('button');
            stationBtn.className = 'tree-station' + (state.current[type] === stationNode.data.id ? ' active' : '');
            stationBtn.textContent = stationNode.data.name;
            stationBtn.style.paddingLeft = '28px';
            stationBtn.dataset.id = stationNode.data.id;
            stationBtn.addEventListener('click', () => onSelect(stationNode.data.id));
            regionContent.appendChild(stationBtn);
          });
          
          regionBtn.addEventListener('click', () => {
            const currentExpanded = regionContent.style.display === 'block';
            const newExpanded = !currentExpanded;
            state.treeExpanded[type][regionName] = newExpanded;
            regionContent.style.display = newExpanded ? 'block' : 'none';
            regionBtn.innerHTML = (newExpanded ? '▼' : '▶') + ' ' + regionName + ' · ' + regionNode.children.length;
          });
          
          treeContainer.appendChild(regionBtn);
          treeContainer.appendChild(regionContent);
        });
        
        requestAnimationFrame(() => {
          tabsEl.scrollTop = scrollTop;
        });
      }
      
      if (chEl) {
        chEl.innerHTML = '';
        chEl.style.display = 'none';
      }
    } else {
      const all = list.length;
      const descriptions = [...new Set(list.map(c => normalizeStr(c.description || '其它')))];
      const activeCat = state.activeCategory[type] || 'all';
      const PAGE_SIZE = 10;

      const fullTabs = [
        { key: 'all', label: '全部', count: all },
        ...descriptions.map(d => ({
          key: d,
          label: d,
          count: list.filter(c => normalizeStr(c.description || '其它') === d).length
        }))
      ];
      
      console.log('前端分类统计:', type, fullTabs);

      const totalPages = Math.max(1, Math.ceil(fullTabs.length / PAGE_SIZE));
      let currentPage = state.presetPage[type] || 0;
      if (currentPage >= totalPages) currentPage = totalPages - 1;
      if (currentPage < 0) currentPage = 0;
      state.presetPage[type] = currentPage;

      const start = currentPage * PAGE_SIZE;
      const visibleTabs = fullTabs.slice(start, start + PAGE_SIZE);

      const tabsEl = panelEl.querySelector('.preset-tabs');
      const chEl = panelEl.querySelector('.preset-channels');
      
      if (tabsEl) {
        tabsEl.innerHTML = '';
        tabsEl.style.display = '';
        tabsEl.style.minHeight = '';
        tabsEl.style.gap = '';

        const leftArrow = document.createElement('button');
        leftArrow.className = 'preset-page-arrow preset-page-arrow-left';
        leftArrow.type = 'button';
        leftArrow.innerHTML = '◀';
        leftArrow.title = '上一页';
        leftArrow.style.visibility = totalPages > 1 ? 'visible' : 'hidden';
        leftArrow.disabled = currentPage === 0;
        leftArrow.addEventListener('click', () => {
          if (state.presetPage[type] > 0) {
            state.presetPage[type]--;
            renderPresets();
          }
        });
        tabsEl.appendChild(leftArrow);

        const gridEl = document.createElement('div');
        gridEl.className = 'preset-tabs-grid';
        tabsEl.appendChild(gridEl);

        const rightArrow = document.createElement('button');
        rightArrow.className = 'preset-page-arrow preset-page-arrow-right';
        rightArrow.type = 'button';
        rightArrow.innerHTML = '▶';
        rightArrow.title = '下一页';
        rightArrow.style.visibility = totalPages > 1 ? 'visible' : 'hidden';
        rightArrow.disabled = currentPage >= totalPages - 1;
        rightArrow.addEventListener('click', () => {
          if (state.presetPage[type] < totalPages - 1) {
            state.presetPage[type]++;
            renderPresets();
          }
        });
        tabsEl.appendChild(rightArrow);

        visibleTabs.forEach(tab => {
          const btn = document.createElement('button');
          btn.className = 'preset-tab' + (activeCat === tab.key ? ' active' : '');
          btn.textContent = tab.label + ' · ' + tab.count;
          btn.addEventListener('click', () => {
            state.activeCategory[type] = tab.key;
            const idx = fullTabs.findIndex(t => t.key === tab.key);
            if (idx >= 0) state.presetPage[type] = Math.floor(idx / PAGE_SIZE);
            renderPresets();
          });
          gridEl.appendChild(btn);
        });
      }

      if (chEl) {
        chEl.style.display = '';
        chEl.innerHTML = '';
        const filtered = activeCat === 'all' ? list : list.filter(c => (c.description || '其它') === activeCat);
        if (filtered.length === 0) {
          const tip = document.createElement('span');
          tip.style.color = '#a88a3a';
          tip.style.fontSize = '12px';
          tip.style.padding = '8px 12px';
          tip.textContent = '该分类暂无频道';
          chEl.appendChild(tip);
          return;
        }
        filtered.forEach(ch => {
          const btn = document.createElement('button');
          btn.className = 'preset-btn' + (state.current[type] === ch.id ? ' active' : '');
          btn.textContent = ch.name.slice(0, 12);
          btn.title = ch.name + (ch.description ? ' — ' + ch.description : '');
          btn.addEventListener('click', () => onSelect(ch.id));
          chEl.appendChild(btn);
        });
      }
    }
  }

  /* -------------------- 旋钮交互（拖拽） -------------------- */
  function setupKnobDrag(knobEl, onChange) {
    let dragging = false;
    let rect;
    const center = () => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

    function angleFromEvent(ev) {
      const pt = ev.touches ? ev.touches[0] : ev;
      const cx = center().x, cy = center().y;
      const dx = pt.clientX - cx, dy = pt.clientY - cy;
      return Math.atan2(dy, dx) * 180 / Math.PI; // -180..180
    }

    function onDown(ev) {
      dragging = true;
      rect = knobEl.getBoundingClientRect();
      ev.preventDefault();
    }
    function onMove(ev) {
      if (!dragging) return;
      const a = angleFromEvent(ev);
      onChange(a, false);
      ev.preventDefault();
    }
    function onUp(ev) {
      if (!dragging) return;
      dragging = false;
      const a = angleFromEvent(ev);
      onChange(a, true);
    }

    knobEl.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    knobEl.addEventListener('touchstart', onDown, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);

    // 点击 -> 旋转 +45 度（切下一个）
    knobEl.addEventListener('click', (e) => {
      if (!dragging) {
        // 小旋转动画
        onChange(null, 'click-next');
      }
    });
  }

  // 初始化调谐旋钮（用于：切下一个电台/TV台；也可拖拽）
  function setupTuneKnob() {
    setupKnobDrag(els.tuneKnob, (angle, isEndOrClick) => {
      if (isEndOrClick === 'click-next') {
        stepNextRadio();
        return;
      }
      if (typeof angle !== 'number') return;
      // 将角度映射到频道 index
      const channels = getChannelsFor('radio');
      if (!channels.length) return;
      // angle 范围 -150..150
      const clamped = Math.max(-150, Math.min(150, angle));
      state.knobAngle.tune = clamped;
      rotateKnob(els.tuneKnob, clamped);
      if (isEndOrClick === true) {
        const normalized = (clamped + 150) / 300;
        const idx = Math.round(normalized * (channels.length - 1));
        selectRadioChannel(channels[idx].id);
      } else {
        const normalized = (clamped + 150) / 300;
        const posPercent = 15 + normalized * 70;
        els.dialNeedle.style.left = posPercent + '%';
      }
    });
  }

  function setupVolumeKnob() {
    setupKnobDrag(els.volumeKnob, (angle, isEndOrClick) => {
      if (isEndOrClick === 'click-next') {
        setVolume('radio', (state.volume.radio + 10) % 110);
        return;
      }
      if (typeof angle !== 'number') return;
      const clamped = Math.max(-135, Math.min(135, angle));
      state.knobAngle.vol = clamped;
      rotateKnob(els.volumeKnob, clamped);
      const v = Math.round(((clamped + 135) / 270) * 100);
      setVolume('radio', v);
    });
  }

  function setupBassKnob() {
    setupKnobDrag(els.bassKnob, (angle, isEndOrClick) => {
      if (isEndOrClick === 'click-next') {
        setEQ('bass', state.eq.bass + 2);
        return;
      }
      if (typeof angle !== 'number') return;
      const clamped = Math.max(-90, Math.min(90, angle));
      state.knobAngle.bass = clamped;
      rotateKnob(els.bassKnob, clamped);
      const gain = Math.round(((clamped + 90) / 180) * 12 - 6);
      setEQ('bass', gain);
    });
  }

  function setupMidKnob() {
    setupKnobDrag(els.midKnob, (angle, isEndOrClick) => {
      if (isEndOrClick === 'click-next') {
        setEQ('mid', state.eq.mid + 2);
        return;
      }
      if (typeof angle !== 'number') return;
      const clamped = Math.max(-90, Math.min(90, angle));
      state.knobAngle.mid = clamped;
      rotateKnob(els.midKnob, clamped);
      const gain = Math.round(((clamped + 90) / 180) * 12 - 6);
      setEQ('mid', gain);
    });
  }

  function setupTrebleKnob() {
    setupKnobDrag(els.trebleKnob, (angle, isEndOrClick) => {
      if (isEndOrClick === 'click-next') {
        setEQ('treble', state.eq.treble + 2);
        return;
      }
      if (typeof angle !== 'number') return;
      const clamped = Math.max(-90, Math.min(90, angle));
      state.knobAngle.treble = clamped;
      rotateKnob(els.trebleKnob, clamped);
      const gain = Math.round(((clamped + 90) / 180) * 12 - 6);
      setEQ('treble', gain);
    });
  }

  function setEQ(type, gain) {
    gain = Math.max(-6, Math.min(6, gain));
    state.eq[type] = gain;
    const A = state.audio;
    if (A.ctx && A.ctx.state !== 'suspended') {
      if (type === 'bass' && A.bassFilter) {
        A.bassFilter.gain.setTargetAtTime(gain, A.ctx.currentTime, 0.1);
      } else if (type === 'mid' && A.midFilter) {
        A.midFilter.gain.setTargetAtTime(gain, A.ctx.currentTime, 0.1);
      } else if (type === 'treble' && A.trebleFilter) {
        A.trebleFilter.gain.setTargetAtTime(gain, A.ctx.currentTime, 0.1);
      }
    }
    const hintEl = type === 'bass' ? els.bassHint : type === 'mid' ? els.midHint : els.trebleHint;
    if (hintEl) {
      hintEl.textContent = (gain > 0 ? '+' : '') + gain + 'dB';
    }
    const knob = type === 'bass' ? els.bassKnob : type === 'mid' ? els.midKnob : els.trebleKnob;
    if (knob) {
      state.knobAngle[type] = ((gain + 6) / 12) * 180 - 90;
      rotateKnob(knob, state.knobAngle[type]);
    }
  }

  function setupTvChKnob() {
    setupKnobDrag(els.tvChKnob, (angle, isEndOrClick) => {
      if (isEndOrClick === 'click-next') {
        stepNextTv();
        return;
      }
      if (typeof angle !== 'number') return;
      const channels = getChannelsFor('tv');
      if (!channels.length) return;
      const clamped = Math.max(-150, Math.min(150, angle));
      state.knobAngle.tvCh = clamped;
      rotateKnob(els.tvChKnob, clamped);
      if (isEndOrClick === true) {
        const normalized = (clamped + 150) / 300;
        const idx = Math.round(normalized * (channels.length - 1));
        selectTvChannel(channels[idx].id);
      }
    });
  }

  function setupTvVolKnob() {
    setupKnobDrag(els.tvVolKnob, (angle, isEndOrClick) => {
      if (isEndOrClick === 'click-next') {
        setVolume('tv', (state.volume.tv + 10) % 110);
        return;
      }
      if (typeof angle !== 'number') return;
      const clamped = Math.max(-135, Math.min(135, angle));
      state.knobAngle.tvVol = clamped;
      rotateKnob(els.tvVolKnob, clamped);
      const v = Math.round(((clamped + 135) / 270) * 100);
      setVolume('tv', v);
    });
  }

  function setupTvFineKnob() {
    // 微调旋钮 - 只做视觉效果
    setupKnobDrag(els.tvFineKnob, (angle, isEndOrClick) => {
      if (isEndOrClick === 'click-next') {
        state.knobAngle.tvFine = (state.knobAngle.tvFine + 30) % 360 - 180;
        rotateKnob(els.tvFineKnob, state.knobAngle.tvFine);
        toast('微调已调整');
        return;
      }
      if (typeof angle !== 'number') return;
      state.knobAngle.tvFine = angle;
      rotateKnob(els.tvFineKnob, angle);
      if (isEndOrClick === true) toast('微调已调整');
    });
  }

  function stepNextRadio() {
    const channels = getChannelsFor('radio');
    if (!channels.length) { toast('请先添加电台', true); return; }
    if (!state.current.radio) {
      selectRadioChannel(channels[0].id); return;
    }
    const curIdx = channels.findIndex(c => c.id === state.current.radio);
    const nextIdx = (curIdx + 1) % channels.length;
    selectRadioChannel(channels[nextIdx].id);
  }
  function stepNextTv() {
    const channels = getChannelsFor('tv');
    if (!channels.length) { toast('请先添加电视台', true); return; }
    if (!state.current.tv) { selectTvChannel(channels[0].id); return; }
    const curIdx = channels.findIndex(c => c.id === state.current.tv);
    const nextIdx = (curIdx + 1) % channels.length;
    selectTvChannel(channels[nextIdx].id);
  }

  function setVolume(device, percent) {
    percent = Math.max(0, Math.min(100, percent));
    state.volume[device] = percent;
    if (device === 'radio') {
      // 通过 Web Audio masterGain 控制主音量（平滑过渡）
      const A = state.audio;
      if (A.masterGain && A.ctx) {
        A.masterGain.gain.cancelScheduledValues(A.ctx.currentTime);
        A.masterGain.gain.setTargetAtTime(percent / 100, A.ctx.currentTime, 0.05);
      } else {
        if (els.radioAudio) els.radioAudio.volume = percent / 100;
        if (els.radioAudioHLS) els.radioAudioHLS.volume = percent / 100;
      }
      if (els.volumeHint) els.volumeHint.textContent = percent + '%';
      state.knobAngle.vol = -135 + (percent / 100) * 270;
      rotateKnob(els.volumeKnob, state.knobAngle.vol);
    } else {
      if (els.tvVideo) {
        els.tvVideo.volume = percent / 100;
        if (percent > 0) els.tvVideo.muted = false;
      }
      if (els.tvVolHint) els.tvVolHint.textContent = percent + '%';
      if (els.tvVolKnob) {
        state.knobAngle.tvVol = -135 + (percent / 100) * 270;
        rotateKnob(els.tvVolKnob, state.knobAngle.tvVol);
      }
    }
  }

  /* -------------------- 频道管理弹窗 -------------------- */
  function openManager() {
    els.channelModal.classList.add('show');
    switchManagerTab(state.currentTab);
  }
  function closeManager() {
    els.channelModal.classList.remove('show');
    closeEditor();
  }
  function switchManagerTab(tab) {
    state.currentTab = tab;
    state.activeCategory.manager = 'all';
    els.tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    renderChannelTable();
  }

  function renderChannelTable() {
    const list = getChannelsFor(state.currentTab);

    if (els.managerFilterTabs) {
      els.managerFilterTabs.innerHTML = '';
      const descriptions = [...new Set(list.map(c => c.description || '其它'))];
      const activeCat = state.activeCategory.manager || 'all';

      const allChip = document.createElement('button');
      allChip.className = 'filter-chip' + (activeCat === 'all' ? ' active' : '');
      allChip.textContent = '全部 · ' + list.length;
      allChip.addEventListener('click', () => {
        state.activeCategory.manager = 'all';
        renderChannelTable();
      });
      els.managerFilterTabs.appendChild(allChip);

      descriptions.forEach(desc => {
        const count = list.filter(c => (c.description || '其它') === desc).length;
        const chip = document.createElement('button');
        chip.className = 'filter-chip' + (activeCat === desc ? ' active' : '');
        chip.textContent = desc + ' · ' + count;
        chip.addEventListener('click', () => {
          state.activeCategory.manager = desc;
          renderChannelTable();
        });
        els.managerFilterTabs.appendChild(chip);
      });
    }

    const activeCat = state.activeCategory.manager || 'all';
    const shown = activeCat === 'all' ? list : list.filter(c => (c.description || '其它') === activeCat);
    els.channelTableBody.innerHTML = '';
    els.emptyHint.classList.toggle('show', shown.length === 0);

    shown.forEach((ch, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${String(idx + 1).padStart(2, '0')}</td>
        <td class="ch-name-cell">
          <span class="ch-dot" style="background:${ch.color || '#d4af37'}; color:${ch.color || '#d4af37'}"></span>
          <strong>${escapeHtml(ch.name)}</strong>
          ${ch.description ? `<small style="color:#a88a3a; margin-left:8px;">${escapeHtml(ch.description)}</small>` : ''}
        </td>
        <td>${escapeHtml(ch.frequency || '-')}</td>
        <td class="url-col">${escapeHtml(ch.url)}</td>
        <td class="ch-actions">
          <button class="btn ch-edit" data-id="${ch.id}">编辑</button>
          <button class="btn ch-del btn-warn" data-id="${ch.id}">删除</button>
        </td>
      `;
      els.channelTableBody.appendChild(tr);
    });

    els.channelTableBody.querySelectorAll('.ch-edit').forEach(btn =>
      btn.addEventListener('click', () => openEditor(btn.dataset.id)));
    els.channelTableBody.querySelectorAll('.ch-del').forEach(btn =>
      btn.addEventListener('click', () => deleteChannel(btn.dataset.id)));
  }

  let editingId = null;

  function openEditor(id) {
    editingId = id || null;
    els.editModalTitle.textContent = id ? '◆ 编辑频道 ◆' : '◆ 添加频道 ◆';
    els.editForm.reset();
    els.editForm.type.value = state.currentTab;

    if (id) {
      const ch = getChannelsFor(state.currentTab).find(c => c.id === id);
      if (ch) {
        els.editForm.name.value = ch.name || '';
        els.editForm.frequency.value = ch.frequency || '';
        els.editForm.url.value = ch.url || '';
        els.editForm.description.value = ch.description || '';
        els.editForm.color.value = ch.color || '#d4af37';
        els.editForm.type.value = ch.type || state.currentTab;
        els.editForm.category.value = ch.category || 'other';
      }
    } else {
      els.editForm.color.value = '#d4af37';
      els.editForm.category.value = 'other';
    }
    els.editModal.classList.add('show');
  }
  function closeEditor() {
    els.editModal.classList.remove('show');
    editingId = null;
  }

  function submitEdit(ev) {
    ev.preventDefault();
    const fd = new FormData(els.editForm);
    const type = (fd.get('type') || state.currentTab).toString();
    const name = (fd.get('name') || '').toString().trim();
    const url = (fd.get('url') || '').toString().trim();
    const frequency = (fd.get('frequency') || '').toString().trim();
    const description = (fd.get('description') || '').toString().trim();
    const color = (fd.get('color') || '#d4af37').toString();
    const category = (fd.get('category') || 'other').toString().trim();

    if (!name || !url) { toast('名称和URL不能为空', true); return; }
    try { new URL(url); } catch (e) { toast('URL格式无效', true); return; }

    if (editingId) {
      // 更新
      const list = state.channels[type];
      const idx = list.findIndex(c => c.id === editingId);
      if (idx !== -1) {
        list[idx] = { ...list[idx], name, url, frequency, description, color, type, category };
      }
      toast('频道已更新');
    } else {
      // 新增
      const ch = { id: generateId(), name, url, frequency, description, color, type, category, createdAt: Date.now() };
      state.channels[type].push(ch);
      toast('频道已添加');
    }

    saveChannels();
    renderChannelTable();
    renderPresets();
    closeEditor();
  }

  function deleteChannel(id) {
    const list = getChannelsFor(state.currentTab);
    const ch = list.find(c => c.id === id);
    if (!ch) return;
    if (!confirm(`确定要删除频道 "${ch.name}" 吗？`)) return;

    state.channels[state.currentTab] = list.filter(c => c.id !== id);
    // 如果当前正在播放该频道 -> 停止
    if (state.current[state.currentTab] === id) {
      state.current[state.currentTab] = null;
      stopPlaying(state.currentTab);
    }
    saveChannels();
    renderChannelTable();
    renderPresets();
    toast('频道已删除');
  }

  function exportChannels() {
    const blob = new Blob([JSON.stringify(state.channels, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `retro-channels-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('频道已导出');
  }

  function importChannels(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data.radio || !data.tv || !Array.isArray(data.radio) || !Array.isArray(data.tv)) {
          throw new Error('格式错误');
        }
        state.channels = data;
        saveChannels();
        renderChannelTable();
        renderPresets();
        toast('已导入 ' + (data.radio.length + data.tv.length) + ' 个频道');
      } catch (err) {
        toast('导入失败：文件格式无效', true);
      }
    };
    reader.readAsText(file);
  }

  function resetToDefaults() {
    if (!confirm('确定要恢复默认频道列表吗？当前的自定义频道将被清空！')) return;
    let defaultData = DEFAULT_CHANNELS;
    try {
      if (typeof CHANNEL_DATA !== 'undefined' && CHANNEL_DATA.radio && CHANNEL_DATA.tv) {
        defaultData = processChannels(CHANNEL_DATA);
      }
    } catch (e) {
      console.warn('处理默认频道数据失败', e);
    }
    state.channels = JSON.parse(JSON.stringify(defaultData));
    state.current = { radio: null, tv: null };
    stopPlaying('radio'); stopPlaying('tv');
    saveChannels();
    renderChannelTable();
    renderPresets();
    toast('已恢复默认频道');
  }

  function escapeHtml(str) {
    return (str || '').toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* -------------------- 键盘支持 -------------------- */
  function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      // 输入框中不处理
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
      // Modal打开时不处理设备控制
      const modalOpen = els.channelModal.classList.contains('show') || els.editModal.classList.contains('show');

      if (e.key === 'Escape') {
        if (els.editModal.classList.contains('show')) closeEditor();
        else if (els.channelModal.classList.contains('show')) closeManager();
        return;
      }
      if (modalOpen) return;

      const device = state.activeDevice;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (device === 'radio') stepNextRadio();
        else stepNextTv();
        e.preventDefault();
      } else if (e.key === ' ') {
        if (device === 'radio') toggleRadioPlay();
        else {
          // TV：未选择时选第一个；否则由浏览器原生控制 video
          if (!state.current.tv) {
            const chs = getChannelsFor('tv');
            if (chs.length) selectTvChannel(chs[0].id);
          } else {
            if (els.tvVideo.paused) els.tvVideo.play();
            else els.tvVideo.pause();
          }
        }
        e.preventDefault();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const delta = e.key === 'ArrowUp' ? 5 : -5;
        setVolume(device, state.volume[device] + delta);
        e.preventDefault();
      } else if (e.key.toLowerCase() === 'p') {
        togglePower(device);
        e.preventDefault();
      } else if (e.key === '1' || e.key === '2') {
        switchDevice(e.key === '1' ? 'radio' : 'tv');
        e.preventDefault();
      }
    });
  }

  /* -------------------- 视频播放状态反馈 -------------------- */
  function setupMediaEvents() {
    els.radioAudio.addEventListener('ended', () => {
      // 某些流会end - 切下一个
      stepNextRadio();
    });
    els.radioAudio.addEventListener('error', () => {
      toast('音频流无法播放（可能是跨域限制）', true);
      state.playing.radio = false;
      els.speakersRadio.forEach(s => s.classList.remove('playing'));
    });

    els.tvVideo.addEventListener('playing', () => {
      state.playing.tv = true;
      els.crtScreen.classList.add('playing');
    });
    els.tvVideo.addEventListener('pause', () => {
      // 保留 playing 类 直到手动停止
    });
    els.tvVideo.addEventListener('error', () => {
      toast('视频流播放错误（可能是跨域限制）', true);
      state.playing.tv = false;
      els.crtScreen.classList.remove('playing');
    });
  }

  /* -------------------- 事件绑定入口 -------------------- */
  function bindEvents() {
    // 设备切换
    els.deviceBtns.forEach(btn => {
      btn.addEventListener('click', () => switchDevice(btn.dataset.device));
    });
    els.managerBtn.addEventListener('click', openManager);

    // 收音机
    els.radioPowerSwitch.addEventListener('click', () => {
      togglePower('radio');
    });
    setupTuneKnob();
    setupVolumeKnob();
    setupBassKnob();
    setupMidKnob();
    setupTrebleKnob();

    // 可视化效果切换
    bindVizButtons();

    // 电视
    els.tvPowerBtn.addEventListener('click', () => togglePower('tv'));
    setupTvChKnob();
    setupTvVolKnob();
    setupTvFineKnob();

    // Modal
    els.closeModalBtn.addEventListener('click', closeManager);
    els.channelModal.addEventListener('click', (e) => {
      if (e.target === els.channelModal) closeManager();
    });
    els.closeEditBtn.addEventListener('click', closeEditor);
    els.cancelEditBtn.addEventListener('click', closeEditor);
    els.editModal.addEventListener('click', (e) => {
      if (e.target === els.editModal) closeEditor();
    });
    els.addChannelBtn.addEventListener('click', () => openEditor(null));
    els.editForm.addEventListener('submit', submitEdit);
    els.exportBtn.addEventListener('click', exportChannels);
    els.importFile.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) importChannels(f);
      e.target.value = '';
    });
    els.resetBtn.addEventListener('click', resetToDefaults);

    els.tabBtns.forEach(b => b.addEventListener('click', () => switchManagerTab(b.dataset.tab)));

    setupKeyboard();
    setupMediaEvents();
  }

  /* -------------------- 初始化 -------------------- */
  function init() {
    // 设置初始音量
    setVolume('radio', 50);
    setVolume('tv', 50);

    // 预设按钮
    renderPresets();

    // 时钟刻度和数字
    const ticksContainer = document.querySelector('.clock-ticks');
    const numbersContainer = document.querySelector('.clock-hour-numbers');
    if (ticksContainer) {
      ticksContainer.innerHTML = '';
      for (let i = 0; i < 60; i++) {
        const tick = document.createElement('div');
        tick.className = 'clock-tick' + (i % 5 === 0 ? ' clock-tick-hour' : '');
        tick.style.setProperty('--tick-angle', i * 6 + 'deg');
        ticksContainer.appendChild(tick);
      }
    }
    if (numbersContainer) {
      numbersContainer.innerHTML = '';
      const radius = 45;
      const centerX = 65;
      const centerY = 65;
      for (let i = 1; i <= 12; i++) {
        const angle = (i - 3) * 30 * Math.PI / 180;
        const x = centerX + radius * Math.cos(angle) - 10;
        const y = centerY + radius * Math.sin(angle) - 10;
        const span = document.createElement('span');
        span.className = 'clock-number';
        span.textContent = i;
        span.style.left = x + 'px';
        span.style.top = y + 'px';
        numbersContainer.appendChild(span);
      }
    }

    // 初始显示
    els.radioChannelName.textContent = '— POWER OFF —';
    els.radioChannelFreq.textContent = '— — —';

    bindEvents();

    // 初始化可视化效果系统
    initVizElements();

    // 小提示
    setTimeout(() => {
      toast('欢迎！点击电源按钮开启设备（收音机 P键 / 1/2切换 ）');
    }, 500);
  }

  // DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
