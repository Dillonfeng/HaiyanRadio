const CHANNEL_DATA = {
  "radio": [
    { "id": "r1", "name": "凤凰卫视资讯台", "frequency": "网络电台", "url": "http://playtv-live.ifeng.com/live/06OLEEWQKN4_audio.m3u8", "color": "#e74c3c", "description": "广东", "category": "新闻" },
    { "id": "r2", "name": "CCTV-13新闻伴音", "frequency": "电视伴音", "url": "https://piccpndali.v.myalicdn.com/audio/cctv13_2.m3u8", "color": "#e74c3c", "description": "中央", "category": "新闻" },
    { "id": "r3", "name": "新闻听天下", "frequency": "网络电台", "url": "https://live.ximalaya.com/radio-first-page-app/live/15007/64.m3u8", "color": "#e74c3c", "description": "全国", "category": "新闻" },
    { "id": "r5", "name": "CNR-1 中国之声", "frequency": "FM106.1", "url": "https://lhttp.qtfm.cn/live/15318317/64k.mp3", "color": "#e74c3c", "description": "中央", "category": "新闻" },
    { "id": "r8", "name": "CNR-2 经济之声", "frequency": "FM96.6", "url": "http://ngcdn002.cnr.cn/live/jjzs/index.m3u8", "color": "#f39c12", "description": "中央", "category": "经济" },
    { "id": "r9", "name": "清晨音乐台", "frequency": "网络电台", "url": "http://lhttp.qingting.fm/live/4915/64k.mp3", "color": "#9b59b6", "description": "全国", "category": "音乐" },
    { "id": "r11", "name": "德云社相声合集", "frequency": "网络电台", "url": "https://live.ximalaya.com/radio-first-page-app/live/999/64.m3u8", "color": "#e67e22", "description": "全国", "category": "文艺" },
    { "id": "r14", "name": "华语金曲500首", "frequency": "网络电台", "url": "http://ls.qingting.fm/live/3412131.m3u8?bitrate=64", "color": "#9b59b6", "description": "全国", "category": "音乐" },
    { "id": "r17", "name": "80后音悦台", "frequency": "网络电台", "url": "https://live.ximalaya.com/radio-first-page-app/live/2629/64.m3u8", "color": "#9b59b6", "description": "全国", "category": "音乐" },
    { "id": "r23", "name": "CNR-3 音乐之声", "frequency": "FM90.0", "url": "https://ngcdn001.cnr.cn/live/yyzs/index.m3u8", "color": "#e74c3c", "description": "中央", "category": "新闻" },
    { "id": "r28", "name": "第一财经", "frequency": "FM97.7", "url": "http://lhttp.qingting.fm/live/276/64k.mp3", "color": "#f39c12", "description": "全国", "category": "经济" },
    { "id": "r31", "name": "广东珠江经济台", "frequency": "FM97.4", "url": "https://lhttp.qtfm.cn/live/1259/64k.mp3", "color": "#f39c12", "description": "广东", "category": "经济" },
    { "id": "r34", "name": "北京新闻广播", "frequency": "FM94.5", "url": "https://lhttp.qtfm.cn/live/339/64k.mp3", "color": "#e74c3c", "description": "北京", "category": "新闻" },
    { "id": "r37", "name": "香港电台", "frequency": "网络电台", "url": "https://rthk.streamabc.com/radio1.mp3", "color": "#34495e", "description": "香港", "category": "综合" },
    { "id": "r49", "name": "广东新闻广播", "frequency": "FM91.4", "url": "https://lhttp.qtfm.cn/live/1254/64k.mp3", "color": "#e74c3c", "description": "广东", "category": "新闻" },
    { "id": "r56", "name": "CCTV-8电视剧伴音", "frequency": "电视伴音", "url": "https://piccpndali.v.myalicdn.com/audio/cctv8_2.m3u8", "color": "#d35400", "description": "中央", "category": "影视" },
    { "id": "r61", "name": "CCTV-15音乐伴音", "frequency": "电视伴音", "url": "https://piccpndali.v.myalicdn.com/audio/cctv15_2.m3u8", "color": "#9b59b6", "description": "中央", "category": "音乐" },
    { "id": "r72", "name": "深圳新闻广播", "frequency": "FM89.8", "url": "http://lhttp.qingting.fm/live/1270/64k.mp3", "color": "#e74c3c", "description": "广东", "category": "新闻" },
    { "id": "r74", "name": "北京文艺广播", "frequency": "FM87.6", "url": "https://lhttp.qtfm.cn/live/333/64k.mp3", "color": "#e67e22", "description": "北京", "category": "文艺" },
    { "id": "r77", "name": "河南戏曲广播", "frequency": "网络电台", "url": "https://stream.hndt.com/live/yule/playlist.m3u8", "color": "#e67e22", "description": "河南", "category": "文艺" },
    { "id": "r83", "name": "北京交通广播", "frequency": "FM103.9", "url": "https://lhttp.qingting.fm/live/336/64k.mp3", "color": "#3498db", "description": "北京", "category": "交通" },
    { "id": "r88", "name": "上海流行音乐广播", "frequency": "FM101.7", "url": "https://lhttp-hw.qtfm.cn/live/274/64k.mp3", "color": "#9b59b6", "description": "上海", "category": "音乐" },
    { "id": "r91", "name": "上海经典音乐广播", "frequency": "FM94.7", "url": "https://lhttp-hw.qtfm.cn/live/267/64k.mp3", "color": "#9b59b6", "description": "中央", "category": "音乐" },
    { "id": "r96", "name": "CCTV-5体育伴音", "frequency": "电视伴音", "url": "https://piccpndali.v.myalicdn.com/audio/cctv5_2.m3u8", "color": "#2ecc71", "description": "中央", "category": "体育" },
    { "id": "r103", "name": "四川新闻广播", "frequency": "FM98.1", "url": "https://lhttp.qtfm.cn/live/4906/64k.mp3", "color": "#e74c3c", "description": "四川", "category": "新闻" },
    { "id": "r105", "name": "CNR-2 经济之声", "frequency": "FM96.6", "url": "https://satellitepull.cnr.cn/live/wxjjzs/playlist.m3u8?wsSession=5849bb6c90cf7fc1a7e3eae9-174908108209742&wsIPSercert=f7b6cfa8467acd0836b62cf14aa786d3", "color": "#f39c12", "description": "中央", "category": "经济" },
    { "id": "r123", "name": "北京音乐广播", "frequency": "FM97.4", "url": "https://lhttp.qtfm.cn/live/332/64k.mp3", "color": "#9b59b6", "description": "北京", "category": "音乐" },
    { "id": "r130", "name": "经济之声", "frequency": "FM96.6", "url": "https://ngcdn002.cnr.cn/live/jjzs/index.m3u8", "color": "#f39c12", "description": "中央", "category": "经济" },
    { "id": "r144", "name": "RTHK Radio-1", "frequency": "网络电台", "url": "https://rthk.streamabc.com/radio1.mp3", "color": "#34495e", "description": "香港", "category": "综合" },
    { "id": "r150", "name": "CCTV-3综艺伴音", "frequency": "电视伴音", "url": "https://piccpndali.v.myalicdn.com/audio/cctv3_2.m3u8", "color": "#d35400", "description": "中央", "category": "影视" },
    { "id": "r165", "name": "CNR-15 中国交通广播", "frequency": "FM99.6", "url": "https://ngcdn002.cnr.cn/live/gsgljtgb/index.m3u8", "color": "#3498db", "description": "中央", "category": "交通" }
  ]
};

function getChannelsFor(type) {
  return CHANNEL_DATA[type] || [];
}

function loadChannels() {
  return CHANNEL_DATA;
}
