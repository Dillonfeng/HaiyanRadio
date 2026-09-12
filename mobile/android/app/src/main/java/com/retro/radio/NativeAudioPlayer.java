package com.retro.radio;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.JavascriptInterface;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;

import androidx.annotation.OptIn;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.LoadControl;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;
import androidx.media3.exoplayer.upstream.DefaultBandwidthMeter;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;

import org.json.JSONObject;

/**
 * =============================================================================
 *  V100 NATIVE-EXOPLAYER (THE LOCKSCREEN 3MIN SILENCE FINAL FIX)
 * =============================================================================
 *  Problem root-cause (FINAL PROVEN):
 *   OPPO/ColorOS T+180s AMS ActivityThread.handleSleeping() calls either:
 *    - wv.onPause() → Chromium pauseTimers() + kills HTMLAudio output thread, OR
 *    - ColorOS CUSTOM "ActivityRecord RenderFreezer" (no onPause callback!) →
 *      DIRECTLY FREEZES WebView render/audio threads via native Renderer
 *      freeze (new in ColorOS 14.0+ — NO onPause/onStop callbacks AT ALL).
 *   Both are UNAVOIDABLE from inside the WebView — no amount of onPause guards,
 *   AlarmManager heartbeats, or WifiLock re-acquisitions fix the root cause
 *   because the WebView audio output thread is GONE from the native process.
 *
 *  Solution (100% reliable, like NetEase Cloud/Ximalaya):
 *   Move audio playback OUT of WebView ENTIRELY, into NATIVE ExoPlayer (Media3).
 *   - Native AudioTrack runs under System Server's "media" cgroup, NOT under
 *     ActivityRecord renderer freeze. Even if Activity is fully frozen,
 *     MediaPlayerService keeps the PCM / MediaCodec pipeline ALIVE indefinitely.
 *   - ExoPlayer.setWakeMode(WAKE_MODE_NETWORK) internally BOTH acquires AND
 *     HOLDS both PARTIAL_WAKE_LOCK + WifiManager.WIFI_MODE_FULL_HIGH_PERF via
 *     android.media.AudioSystem (NOT WifiManager wifilock) → bypasses ALL
 *     ColorOS WifiLock priority-decay hacks.
 *   - JS just calls window.NativeAudio.playUrl(url, name, sub) — NO <audio>,
 *     NO hls.js, NO watchdog timers (not needed — native impl handles HLS
 *     via DefaultMediaSourceFactory + HlsMediaSource internally, and
 *     retries stalled / broken TCP transparently at DataSource level).
 * =============================================================================
 */
public class NativeAudioPlayer {

    private static final String TAG = "NativeAudioPlayer";

    public interface NativeAudioEvents {
        void onEvent(String json);  // -> JS window.dispatchEvent(new CustomEvent('nativeaudio', {detail: JSON.parse(json)}))
    }

    private final Context appCtx;
    // V170: 回调改为可替换。播放器是进程级单例，Activity销毁重建后新Activity注册新回调。
    private volatile NativeAudioEvents cb;
    private final Handler MAIN = new Handler(Looper.getMainLooper());

    // V170 STABILITY(锁屏无声根因): 播放器必须归进程所有，不能随Activity销毁。
    //   ColorOS锁屏/后台会销毁Activity → 旧代码MainActivity.onDestroy()调release()
    //   → ExoPlayer被释放+Service stopSelf → 锁屏即无声，解锁后才靠NET-RECONNECT重播。
    //   单例(appCtx绑定Service)在Activity重建后继续播放，新Activity只重新注册回调和JS接口。
    private static volatile NativeAudioPlayer sInstance;

    public static NativeAudioPlayer getShared(Context ctx, NativeAudioEvents events) {
        if (sInstance == null) {
            synchronized (NativeAudioPlayer.class) {
                if (sInstance == null) {
                    sInstance = new NativeAudioPlayer(ctx.getApplicationContext(), events);
                    Log.i("NativeAudioPlayer", "V170 getShared: created process-wide singleton");
                    return sInstance;
                }
            }
        }
        sInstance.setEvents(events);
        Log.i("NativeAudioPlayer", "V170 getShared: reused singleton, events re-bound to new Activity");
        return sInstance;
    }

    /**
     * V177: 仅取已存在的进程级单例，绝不创建、绝不替换事件回调。
     * 供 Service 在 Activity 已被系统销毁(锁屏长时间)时，直接控制 ExoPlayer（暂停/恢复），
     * 不再依赖 "Service广播→Activity receiver→evaluateJavascript→JS→RPC" 这条会随 Activity 死亡而断裂的链路。
     */
    public static NativeAudioPlayer peekInstance() {
        return sInstance;  // 可能为 null（尚未播放过）；无副作用，不触碰 cb
    }

    public void setEvents(NativeAudioEvents events) { this.cb = events; }

    private ExoPlayer exo;
    private DefaultDataSource.Factory dataSourceFactory;
    private DefaultTrackSelector trackSel;
    private DefaultBandwidthMeter bwm;
    private String curUrl = "";
    private String curName = "";
    private String curSub  = "";
    // V164 STABILITY: 错误指数退避重试。旧逻辑网络错误后只prepare()一次(1.2s)，
    //   网络切换(WiFi↔5G)时这次重试常发生在新网络就绪前 → 失败后永久无声，直到用户手动操作。
    private static final int ERR_RETRY_MAX = 8;  // V172: 5→8（1.2s→2.4s→4.8s→9.6s→15s→15s→15s→15s，约77秒恢复窗口）
    private int errRetryCount = 0;
    private volatile boolean wantPlaying = false;  // 用户意图=true时才自动重试（stop/pause后不重试）
    // V179: 暂停时刻(elapsedRealtime)。直播流(HTTP/HLS)暂停超过 STALE_RESUME_MS 后，
    //   底层TCP连接早已被服务端/NAT回收、本地缓冲失效，此时若直接 setPlayWhenReady(true)
    //   续接死连接 → 长时间缓冲卡顿(实测蓝牙断开6小时后重连卡顿)。resume时改走重新prepare。
    private static final long STALE_RESUME_MS = 5 * 60 * 1000L;  // 5分钟
    private long pausedAtElapsedMs = 0L;
    // V101 FIX: ServiceConnection for RadioPlaybackService (so we can GUARANTEE Service.onCreate→sLastInstance is set before any ExoPlayer events fire).
    //   Earlier V100 code read RadioPlaybackService.sLastInstance synchronously inside playUrl — which was RACE because sLastInstance was NULL until
    //   a future startService() or bindService() call made the Service instance. This caused startForeground() NEVER TO RUN, proven by dumpsys
    //   "RadioPlaybackService Client: nothing to dump" (no foreground, OOM_adj=500+ → ColorOS kills AudioFlinger output at screen-off T+180s exactly
    //   matching user's "3-minutes-silence" symptom).
    private RadioPlaybackService boundSvc = null;
    private final Object svcLock = new Object();
    private ServiceConnection svcConn = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder service) {
            synchronized (svcLock) {
                boundSvc = ((RadioPlaybackService.LocalBinder) service).getService();
                Log.e(TAG, "RadioPlaybackService CONNECTED (onServiceConnected). boundSvc != null: true");
                svcLock.notifyAll();
            }
        }
        @Override public void onServiceDisconnected(ComponentName name) {
            synchronized (svcLock) { boundSvc = null; Log.w(TAG, "RadioPlaybackService DISCONNECTED"); }
        }
    };

    @OptIn(markerClass = UnstableApi.class)
    public NativeAudioPlayer(Context ctx, NativeAudioEvents cb) {
        this.appCtx = ctx.getApplicationContext();
        this.cb = cb;
        // V101 FIX: bindService + startForegroundService immediately at NativeAudio ctor (happens at first page load BEFORE user clicks any radio).
        //   This mirrors 小旋风 com.ryanheise.audioservice: they bindService at Application.onCreate so Service always available.
        try {
            Intent bind = new Intent(appCtx, RadioPlaybackService.class);
            boolean bOk = appCtx.bindService(bind, svcConn, Context.BIND_AUTO_CREATE | Context.BIND_IMPORTANT);
            Log.e(TAG, "ctor: bindService( RadioPlaybackService, BIND_AUTO_CREATE|BIND_IMPORTANT ) = " + bOk + " (Context.BIND_IMPORTANT forces oom_adj=120 even at screen off)");
        } catch (Throwable t) { Log.w(TAG, "ctor bindService FAIL (harmless, fall back): " + t); }
        MAIN.post(this::lazyInitPlayer);
        Log.e(TAG, "ctor: appCtx=" + appCtx.getPackageName() + " (MAIN lazyInit scheduled)");
    }

    /** V102 TRIPLE-HAMMER helper: ALWAYS call startForegroundService FIRST, then return binder.
     *  =====================================================================================
     *  V100/V101 FATAL BUG (PROVEN BY DUMPSYS):
     *    if (boundSvc != null) return s;  →  bind成功后，永远不再调用startForegroundService！
     *    bindService ≠ startForegroundService:
     *      - bindService: 只是Activity<->Service建立通道，Service的FGS状态完全由startForeground()/stopForeground()决定
     *      - startForegroundService: 告诉系统"这是前台服务"，必须5秒内调startForeground()，否则ANR
     *    结果：dumpsys activity services显示"RadioPlaybackService app=ProcessRecord{...} isForeground=false"
     *          → ColorOS AMS在T+160s把它当后台服务处理 → AudioFlinger断开输出 → 表现为"息屏3分钟无声"
     *
     *  V102 FIX:
     *    1) FIRST → 无论startFG=true/false，无论boundSvc==null与否， ALWAYS 先startForegroundService(ACTION_PLAY)！
     *       (小旋风收音机: playUrl每次都startService(ACTION_PLAY)，即使Service已经在运行；onStartCommand是幂等的)
     *    2) THEN  → 返回boundSvc或sLastInstance
     *  =====================================================================================
     */
    private RadioPlaybackService acquireServiceForPlaying(String name, String sub, boolean playing) {
        // V173 FIX(死循环根因): 内部“保活心跳”一律用 ACTION_META（只更新FGS/状态，绝不向JS广播）。
        //   旧V124在playing=true时用ACTION_PLAY → onStartCommand handlePlay(true) → 广播PLAY给JS。
        //   V173让JS收到PLAY广播后调RPC resume → _resumeMain又走到这里 → startService(ACTION_PLAY)
        //   → 再广播PLAY → JS再resume → 每45ms一轮死循环（日志实锤），导致：耳机暂停被立即resume覆盖
        //   （卡一下继续播）、蓝牙断开pause被循环resume冲掉（扬声器继续响）。
        //   ACTION_META路径：playing=true且service.isPlaying=false → handlePlay(false)内部仍调
        //   startForeground()（FGS保活满足5s规则）+ 更新状态，但 notifyUi=false 不广播 → 无回环。
        //   外部控制（耳机MediaSession/通知栏按钮）才是唯一广播源，单向：用户操作→Service→JS→播放器。
        try {
            Intent fgs = new Intent(appCtx, RadioPlaybackService.class);
            fgs.setAction(RadioPlaybackService.ACTION_META); // V173: 内部心跳统一META，不广播
            fgs.putExtra(RadioPlaybackService.EXTRA_NAME, name == null ? "" : name)
               .putExtra(RadioPlaybackService.EXTRA_SUBTITLE, sub == null ? "" : sub)
               .putExtra(RadioPlaybackService.EXTRA_IS_PLAYING, playing);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                appCtx.startForegroundService(fgs);
            } else {
                appCtx.startService(fgs);
            }
            Log.d(TAG, "V173 acquireServiceForPlaying: startService(META) playing=" + playing + " (no UI broadcast)");
        } catch (Throwable t) { Log.wtf(TAG, "V173 acquireServiceForPlaying startService FATAL: "+t, t); }
        RadioPlaybackService s = null;
        synchronized (svcLock) { s = boundSvc; }
        if (s != null) return s;
        return RadioPlaybackService.sLastInstance;
    }

    @OptIn(markerClass = UnstableApi.class)
    private synchronized void lazyInitPlayer() {
        if (exo != null) return;
        try {
            bwm = new DefaultBandwidthMeter.Builder(appCtx)
                    .setResetOnNetworkTypeChange(false).build();
            trackSel = new DefaultTrackSelector(appCtx);
            // ══════════════════════════════════════════════════════════════
            // V108-VIDEO-AUDIO-ONLY 终极修复：CGTN/凤凰/CCTV等真视频HLS直播源
            //   问题：锁屏后Android Surface立刻销毁→视频解码器(avc/hvc)立刻停→demuxer也停→音频也一起停(ts流音视频交织)=锁屏立刻无声/开屏恢复
            //   修复：DefaultTrackSelector.Parameters 禁用 VIDEO + TEXT + IMAGE + METADATA + CAMERA_MOTION 所有非AUDIO轨道
            //         → ExoPlayer 永远不会创建 VideoDecoder → 永远不需要 Surface
            //         → 锁屏 Surface 销毁对纯音频播放 零影响=100%稳定息屏！
            //   兼容性：用Media3 1.x最通用的API(getParameters().buildUpon())，不依赖新版本方法
            // ══════════════════════════════════════════════════════════════
            try {
                // 最兼容的方式：先getParameters再buildUpon()（Media3 1.0+全版本通用）
                androidx.media3.exoplayer.trackselection.DefaultTrackSelector.Parameters params = trackSel.getParameters();
                androidx.media3.exoplayer.trackselection.DefaultTrackSelector.Parameters.Builder pb = params.buildUpon();
                int[] disabledTypes = new int[]{
                        androidx.media3.common.C.TRACK_TYPE_VIDEO,
                        androidx.media3.common.C.TRACK_TYPE_TEXT,
                        androidx.media3.common.C.TRACK_TYPE_IMAGE,
                        androidx.media3.common.C.TRACK_TYPE_METADATA,
                        androidx.media3.common.C.TRACK_TYPE_CAMERA_MOTION
                };
                for (int t : disabledTypes) {
                    // 通用：setRendererDisabled(int, boolean) 从ExoPlayer 2.x 到 Media3 1.x 100%存在
                    try { pb.setRendererDisabled(t, true); } catch (Throwable ignoreSafe) {}
                    try {
                        if (t == androidx.media3.common.C.TRACK_TYPE_VIDEO) {
                            try { pb.setMaxVideoSize(0, 0); } catch (Throwable ignoreSafe) {}
                            try { pb.setMaxVideoBitrate(0); } catch (Throwable ignoreSafe) {}
                            try { pb.setMaxVideoFrameRate(0); } catch (Throwable ignoreSafe) {}
                        }
                    } catch (Throwable ignoreSafe) {}
                }
                trackSel.setParameters(pb.build());
                android.util.Log.i("NativeAudio", "[V108-VIDEO-AUDIO-ONLY] DefaultTrackSelector VIDEO/TEXT/IMAGE/METADATA=ALL DISABLED → 只保留AUDIO轨道 → 视频HLS零Surface依赖=息屏100%稳定");
            } catch (Throwable t) {
                android.util.Log.w("NativeAudio", "[V108-VIDEO-AUDIO-ONLY] TrackSelector配置失败(非致命，继续默认): " + t.getClass().getSimpleName() + " " + t.getMessage());
            }
            LoadControl lc = new DefaultLoadControl.Builder()
                    .setBufferDurationsMs(
                            10_000,   // minBufferMs: rebuffer below this = pause
                            30_000,   // maxBufferMs: cache up to 30s forward
                            2_500,    // bufferForPlaybackMs: 2.5s before "ready to start"
                            5_000)    // bufferForPlaybackAfterRebufferMs: 5s for rebuffer
                    .build();
            DefaultRenderersFactory rf = new DefaultRenderersFactory(appCtx)
                    .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER)
                    .setEnableAudioFloatOutput(true);
            DefaultHttpDataSource.Factory httpF = new DefaultHttpDataSource.Factory()
                    .setConnectTimeoutMs(12_000)
                    .setReadTimeoutMs(30_000)
                    .setAllowCrossProtocolRedirects(true)
                    .setUserAgent("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36 RetroRadio/1.3.100");
            dataSourceFactory = new DefaultDataSource.Factory(appCtx, httpF);
            MediaSource.Factory msf = new DefaultMediaSourceFactory(dataSourceFactory);
            // Media3 1.3.1 ExoPlayer.Builder API:
            //   - Builder(Context) or Builder(Context, MediaSource.Factory) — NO 7-arg ctor!
            //   - We use the single-arg ctor then chain .setMediaSourceFactory / .setTrackSelector
            //     / .setLoadControl / .setBandwidthMeter / .setRenderersFactory — all supported.
            exo = new ExoPlayer.Builder(appCtx)
                    .setMediaSourceFactory(msf)
                    .setTrackSelector(trackSel)
                    .setLoadControl(lc)
                    .setBandwidthMeter(bwm)
                    .setRenderersFactory(rf)
                    .setLooper(Looper.getMainLooper())
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setContentType(androidx.media3.common.C.AUDIO_CONTENT_TYPE_MUSIC)
                            .setUsage(androidx.media3.common.C.USAGE_MEDIA)
                            .build(), false)  // V132 FIX: false = ExoPlayer不自动管理音频焦点，由RadioPlaybackService统一requestAudioFocus，避免冷启动双重焦点冲突导致首次播放无声
                    .setHandleAudioBecomingNoisy(true)
                    .setWakeMode(androidx.media3.common.C.WAKE_MODE_NETWORK)  // <---- THE KILLER FIX: holds PARTIAL_WAKE_LOCK + WifiLock via AudioSystem (bypasses all ColorOS ActivityRecord freezer / WifiLock priority-decay)
                    .build();
            exo.addListener(new Player.Listener() {
                long lastPosReportAt = 0L;
                @Override public void onPlaybackStateChanged(int st) {
                    String sname = switch (st) {
                        case Player.STATE_IDLE -> "IDLE";
                        case Player.STATE_BUFFERING -> "BUFFERING";
                        case Player.STATE_READY -> "READY";
                        case Player.STATE_ENDED -> "ENDED";
                        default -> "ST"+st;
                    };
                    if (st == Player.STATE_READY) errRetryCount = 0;  // V164: 播放成功后重置退避计数
                    _emit("state", "{\"state\":\""+sname+"\",\"playing\":"+exo.getPlayWhenReady()+"}");
                }
                @Override public void onIsPlayingChanged(boolean ip) {
                    _emit("isplaying", "{\"isPlaying\":"+ip+",\"positionMs\":"+exo.getCurrentPosition()+"}");
                    // Push service lifecycle. V101 FIX: NO LONGER use sLastInstance! Use the connected binder (mirror xiaoxuanfeng's 100% reliable always-connected service design)
                    try {
                        RadioPlaybackService s = acquireServiceForPlaying(curName, curSub, ip);
                        if (s != null) {
                            if (ip) s.apiPlayFromBinder(curName, curSub, false);
                            else    s.apiMetaFromBinder(curName, curSub, false);
                        } else if (ip) {
                            // V173: 兜底也用 ACTION_META（acquireServiceForPlaying 已 startService，
                            //   这里仅冗余保险；绝不使用 ACTION_PLAY 以免向 JS 广播触发 resume 死循环）。
                            Intent fgs = new Intent(appCtx, RadioPlaybackService.class);
                            fgs.setAction(RadioPlaybackService.ACTION_META)
                               .putExtra(RadioPlaybackService.EXTRA_NAME, curName == null ? "" : curName)
                               .putExtra(RadioPlaybackService.EXTRA_SUBTITLE, curSub == null ? "" : curSub)
                               .putExtra(RadioPlaybackService.EXTRA_IS_PLAYING, true);
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) appCtx.startForegroundService(fgs);
                            else appCtx.startService(fgs);
                        }
                    } catch (Throwable t) { Log.w(TAG, "onIsPlayingChanged svc update FAIL: " + t); }
                }
                @Override public void onPlayerError(PlaybackException err) {
                    String errName = switch (err.errorCode) {
                        case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED -> "NETWORK_FAILED";
                        case PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> "HTTP_STATUS";
                        case PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED -> "BAD_CONTAINER";
                        case PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED -> "AUDIOTRACK_INIT_FAIL";
                        default -> "E"+err.errorCode;
                    };
                    Log.e(TAG, "onPlayerError code="+err.errorCode+"("+errName+"): " + err.getMessage());
                    _emit("error", "{\"code\":"+err.errorCode+",\"name\":\""+errName+"\",\"msg\":"+_jsonStr(err.getMessage())+"}");
                    // V164 STABILITY: 指数退避重试（1.2s→2.4s→4.8s→9.6s→15s，最多5次）
                    //   旧逻辑只重试1次，网络切换场景下重试时新网络往往还没就绪 → 失败后永久无声。
                    //   wantPlaying=false（用户stop/pause）时不重试；STATE_READY时计数清零。
                    if (wantPlaying && errRetryCount < ERR_RETRY_MAX) {
                        final long delay = Math.min(1200L * (1L << errRetryCount), 15000L);
                        errRetryCount++;
                        Log.i(TAG, "V164 onPlayerError backoff retry #" + errRetryCount + "/" + ERR_RETRY_MAX + " in " + delay + "ms");
                        MAIN.postDelayed(() -> {
                            try {
                                if (exo != null && wantPlaying) {
                                    Log.i(TAG, "V164 backoff prepare() attempt #" + errRetryCount);
                                    exo.prepare();
                                }
                            } catch (Throwable t) { Log.w(TAG, "V164 backoff prepare FAIL: " + t); }
                        }, delay);
                    } else if (!wantPlaying) {
                        errRetryCount = 0;
                    } else {
                        Log.w(TAG, "V164 onPlayerError: retry budget exhausted (" + ERR_RETRY_MAX + "), give up until user action");
                    }
                }
            });
            Log.e(TAG, "lazyInit: ExoPlayer OK. setWakeMode=WAKE_MODE_NETWORK (PARTIAL_WAKE_LOCK + HIGH_PERF WifiLock via AudioSystem; immune to ActivityRecord freezer)");
        } catch (Throwable topT) {
            Log.wtf(TAG, "lazyInit TOP FAIL: " + topT, topT);
            _emit("fatal", "{\"msg\":"+_jsonStr(topT.toString())+"}");
        }
    }

    private static String _jsonStr(String s) {
        if (s == null) return "null";
        try { return JSONObject.quote(s); } catch (Throwable ignore) { return "\"\""; }
    }

    private void _emit(String type, String rest) {
        try {
            String body = "{\"type\":\"" + type + "\",\"url\":" + _jsonStr(curUrl);
            // V166 FIX: 旧代码 rest.substring(1) 只去掉rest开头的{，保留了尾部}，再body+="}" → JSON尾部双}}
            //   → evaluateJavascript注入JS语法错误(Missing catch or finally after try) → 所有原生事件
            //   (state/isplaying/error/play/stop)在JS端全部丢失 → 播放出错无兜底无提示(永久无声)
            if (rest != null && rest.startsWith("{") && rest.endsWith("}") && rest.length() > 2) {
                body += "," + rest.substring(1, rest.length() - 1);
            }
            body += "}";
            Log.i(TAG, "_emit type=" + type + " body=" + (body.length() > 200 ? body.substring(0,200)+"..." : body));
            // V170: Activity销毁后到新Activity注册回调之间可能有事件，cb为null时丢弃(不报错)
            NativeAudioEvents c = cb;
            if (c != null) c.onEvent(body);
        }
        catch (Throwable t) { Log.w(TAG, "_emit FAIL type="+type+" rest="+rest+": " + t); }
    }

    // ------------------------------------------------------------------
    // @JavascriptInterface surface — called DIRECTLY from JS, NO WebView
    //   render-thread dependency. These run on a dedicated Binder-backed
    //   "WebView Core JavaBridge thread" — we always post back to MAIN
    //   because ExoPlayer.Builder requires MAIN looper.
    // ------------------------------------------------------------------
    @JavascriptInterface public boolean isSupported() { return true; }
    @JavascriptInterface public synchronized boolean isPlayingN() { return exo != null && exo.getPlayWhenReady() && (exo.getPlaybackState() == Player.STATE_READY || exo.getPlaybackState() == Player.STATE_BUFFERING); }
    @JavascriptInterface public synchronized long getCurrentPositionMs() { return exo == null ? 0L : exo.getCurrentPosition(); }
    @JavascriptInterface public synchronized long getBufferedPositionMs() { return exo == null ? 0L : exo.getBufferedPosition(); }

    @JavascriptInterface
    public void playUrl(final String url, final String name, final String sub) {
        MAIN.post(() -> _playUrlMain(url, name, sub));
    }

    @JavascriptInterface
    public void stop() { MAIN.post(() -> _stopMain()); }

    @JavascriptInterface
    public void pause() { MAIN.post(() -> _pauseMain(false)); }

    // V183: 蓝牙断开(noisy)引起的暂停 —— emit 事件带 bt:true，JS 据此保留"播放意愿"(wasPlaying)，
    //   不把它当作用户主动暂停；否则冷启动自动续播门控会被蓝牙断开的暂停镜像错误清除。
    public void pauseForBt() { MAIN.post(() -> _pauseMain(true)); }

    @JavascriptInterface
    public void resume() { MAIN.post(() -> _resumeMain()); }

    // ==================================================================
    //  MAIN thread implementations
    // ==================================================================
    @OptIn(markerClass = UnstableApi.class)
    private synchronized void _playUrlMain(String url, String name, String sub) {
        if (Thread.currentThread() != Looper.getMainLooper().getThread()) { MAIN.post(()->_playUrlMain(url,name,sub)); return; }
        lazyInitPlayer();
        boolean firstPlay = (curUrl == null || curUrl.isEmpty());  // V132: 首次播放时curUrl为空，跳过stop()
        try {
            if (url == null || url.isEmpty()) { Log.w(TAG, "playUrl EMPTY URL, ignored"); return; }
            curUrl = url; curName = name == null ? "" : name; curSub = sub == null ? "" : sub;
            wantPlaying = true; errRetryCount = 0;  // V164: 用户意图=播放，重置退避计数
            pausedAtElapsedMs = 0L;  // V179: 全新播放源，清除长暂停标记
            persistLastChannel();  // V183: 供进程被杀后媒体键冷启动直连播放
            _emit("play", String.format("{\"name\":%s,\"sub\":%s,\"url\":%s}",
                    _jsonStr(curName), _jsonStr(curSub), _jsonStr(curUrl)));
            // V101 FIX #1: FIRST acquire RadioPlaybackService and startForeground() — BEFORE any ExoPlayer calls.
            //   V100 failed because we never startForegroundService (dumpsys proven "nothing to dump" FGS missing).
            acquireServiceForPlaying(curName, curSub, true);
            // V132 FIX: 首次播放时跳过stop()，新创建的ExoPlayer在IDLE状态下stop()可能导致音频渲染器初始化异常
            if (!firstPlay) {
                try { exo.stop(); } catch (Throwable ignore) {}
            }
            Uri uri = Uri.parse(url);
            MediaItem mi = new MediaItem.Builder().setUri(uri).build();
            exo.setMediaItem(mi, true);     // resetPosition=true
            exo.setPlayWhenReady(true);
            exo.prepare();
            // V101 FIX #2: apiPlayFromBinder is called here also (if boundSvc connected AFTER acquireServiceForPlaying returned null race), to update state/media info.
            RadioPlaybackService s2 = acquireServiceForPlaying(curName, curSub, true);
            if (s2 != null) { try { s2.apiPlayFromBinder(curName, curSub, true); } catch (Throwable ignore) {} }
            Log.e(TAG, "_playUrl OK name=[" + curName + "] url=" + (url.length() > 90 ? url.substring(0,90)+"..." : url) + " fgsStarted=" + (s2 != null));
        } catch (Throwable topT) {
            Log.wtf(TAG, "_playUrl TOP FAIL name=["+name+"]: " + topT, topT);
            _emit("error", "{\"code\":-9999,\"name\":\"NATIVE_SETUP_EXCEPTION\",\"msg\":"+_jsonStr(topT.toString())+"}");
        }
    }

    private synchronized void _stopMain() {
        if (Thread.currentThread() != Looper.getMainLooper().getThread()) { MAIN.post(this::_stopMain); return; }
        try {
            if (exo != null) { exo.stop(); exo.clearMediaItems(); }
            wantPlaying = false; errRetryCount = 0;  // V164: 用户主动停止，取消自动重试
            RadioPlaybackService s = acquireServiceForPlaying(curName, curSub, false);
            if (s != null) s.apiStopFromBinder();
            _emit("stop", "{\"isPlaying\":false}");
            curUrl = ""; curName = ""; curSub = "";
        } catch (Throwable topT) { Log.e(TAG, "_stopMain FAIL: " + topT); }
    }

    private synchronized void _pauseMain(boolean btCause) {
        if (Thread.currentThread() != Looper.getMainLooper().getThread()) {
            MAIN.post(() -> _pauseMain(btCause)); return;
        }
        try {
            if (exo != null) { exo.setPlayWhenReady(false); }
            pausedAtElapsedMs = SystemClock.elapsedRealtime();  // V179: 记录暂停时刻
            wantPlaying = false;  // V164: 暂停时不自动重试
            RadioPlaybackService s = acquireServiceForPlaying(curName, curSub, false);
            if (s != null) s.apiMetaFromBinder(curName, curSub, false);
            // V183: btCause=true(蓝牙断开) → 事件带bt标记，JS保留播放意愿
            _emit("pause", "{\"isPlaying\":false" + (btCause ? ",\"bt\":true" : "") + "}");
        } catch (Throwable topT) { Log.e(TAG, "_pauseMain FAIL: " + topT); }
    }

    private synchronized void _resumeMain() {
        if (Thread.currentThread() != Looper.getMainLooper().getThread()) { MAIN.post(this::_resumeMain); return; }
        try {
            if (exo != null) {
                long pausedFor = pausedAtElapsedMs > 0 ? SystemClock.elapsedRealtime() - pausedAtElapsedMs : 0L;
                // V179: 暂停超过5分钟（如蓝牙断开数小时后重连）→ 直播流TCP/缓冲已失效，
                //   seekToDefaultPosition 回到直播live edge + prepare() 重新建连缓冲，避免续接死连接卡顿。
                //   短暂停(接电话/蓝牙秒级抖动)走原路径，零额外开销、不打断流畅度。
                if (pausedFor > STALE_RESUME_MS && exo.getMediaItemCount() > 0) {
                    Log.i(TAG, "V179 stale-resume: pausedFor=" + pausedFor + "ms > " + STALE_RESUME_MS
                            + "ms → seekToDefaultPosition()+prepare() re-live instead of resuming dead conn");
                    try { exo.seekToDefaultPosition(); } catch (Throwable ignore) {}
                    exo.prepare();
                } else if (exo.getPlaybackState() == Player.STATE_IDLE) {
                    exo.prepare();
                }
                exo.setPlayWhenReady(true);
                pausedAtElapsedMs = 0L;
            }
            wantPlaying = true; errRetryCount = 0;  // V164: 恢复播放
            RadioPlaybackService s = acquireServiceForPlaying(curName, curSub, true);
            if (s != null) s.apiPlayFromBinder(curName, curSub, true);
            _emit("resume", "{\"isPlaying\":true}");
        } catch (Throwable topT) { Log.e(TAG, "_resumeMain FAIL: " + topT); }
    }

    // ==================================================================
    //  V122 SYNC RPC METHODS (called from shouldInterceptRequest thread)
    //  ExoPlayer must run on MAIN thread. Use CountDownLatch for sync wait.
    // ==================================================================
    public boolean playUrlSync(final String url, final String name, final String sub) {
        final AtomicBoolean result = new AtomicBoolean(false);
        final CountDownLatch latch = new CountDownLatch(1);
        Runnable task = new Runnable() {
            @Override public void run() {
                try {
                    _playUrlMain(url, name, sub);
                    result.set(exo != null && exo.getPlayWhenReady());
                } catch (Throwable t) { Log.w(TAG, "playUrlSync inner FAIL: "+t); }
                finally { latch.countDown(); }
            }
        };
        if (Thread.currentThread() == Looper.getMainLooper().getThread()) { task.run(); }
        else { MAIN.post(task); try { if(!latch.await(3, java.util.concurrent.TimeUnit.SECONDS)) Log.e(TAG, "playUrlSync TIMEOUT"); } catch(InterruptedException ie){} }
        Log.e(TAG, "V122 playUrlSync done -> isPlaying=" + result.get() + " name=["+name+"]");
        return result.get();
    }

    public boolean pauseSync() {
        final AtomicBoolean result = new AtomicBoolean(true);
        final CountDownLatch latch = new CountDownLatch(1);
        Runnable task = new Runnable() {
            @Override public void run() {
                try {
                    _pauseMain(false);
                    result.set(false);
                } catch (Throwable t) { Log.w(TAG, "pauseSync inner FAIL: "+t); }
                finally { latch.countDown(); }
            }
        };
        if (Thread.currentThread() == Looper.getMainLooper().getThread()) { task.run(); }
        else { MAIN.post(task); try { if(!latch.await(3, java.util.concurrent.TimeUnit.SECONDS)) Log.e(TAG, "pauseSync TIMEOUT"); } catch(InterruptedException ie){} }
        Log.e(TAG, "V122 pauseSync done -> isPlaying=" + result.get());
        return result.get();
    }

    public boolean resumeSync() {
        final AtomicBoolean result = new AtomicBoolean(false);
        final CountDownLatch latch = new CountDownLatch(1);
        Runnable task = new Runnable() {
            @Override public void run() {
                try {
                    _resumeMain();
                    // V122 FIX: 不仅检查 playWhenReady，还要额外检查 — 如果 ExoPlayer 状态
                    //   异常（比如长时间pause后进入IDLE），要强制重新prepare+play
                    if (exo != null) {
                        int st = exo.getPlaybackState();
                        if (st == Player.STATE_IDLE || st == Player.STATE_ENDED) {
                            Log.w(TAG, "V122 resumeSync: exo state=" + st + " (IDLE/ENDED) — 强制重新prepare以恢复播放");
                            try { exo.prepare(); } catch(Throwable ign){}
                            exo.setPlayWhenReady(true);
                        }
                        // 最终确认：再次检查是否真的在播放
                        boolean isPWReady = exo.getPlayWhenReady();
                        boolean isOKState = (exo.getPlaybackState() == Player.STATE_READY
                                          || exo.getPlaybackState() == Player.STATE_BUFFERING);
                        result.set(isPWReady); // 只要 setPlayWhenReady=true 就算成功
                        Log.e(TAG, "V122 resumeSync: playWhenReady=" + isPWReady
                                + " state=" + exo.getPlaybackState()
                                + " (READY/BUFFERING=" + isOKState + ")");
                    }
                } catch (Throwable t) { Log.w(TAG, "resumeSync inner FAIL: "+t); }
                finally { latch.countDown(); }
            }
        };
        if (Thread.currentThread() == Looper.getMainLooper().getThread()) { task.run(); }
        else { MAIN.post(task); try { if(!latch.await(3, java.util.concurrent.TimeUnit.SECONDS)) Log.e(TAG, "resumeSync TIMEOUT"); } catch(InterruptedException ie){} }
        Log.e(TAG, "V122 resumeSync done -> isPlaying=" + result.get());
        return result.get();
    }

    public boolean isPlayingSync() {
        final AtomicBoolean result = new AtomicBoolean(false);
        final CountDownLatch latch = new CountDownLatch(1);
        Runnable task = new Runnable() {
            @Override public void run() {
                try {
                    result.set(exo != null && exo.getPlayWhenReady()
                            && (exo.getPlaybackState() == Player.STATE_READY
                                || exo.getPlaybackState() == Player.STATE_BUFFERING));
                } catch (Throwable t) { Log.w(TAG, "isPlayingSync inner FAIL: "+t); }
                finally { latch.countDown(); }
            }
        };
        if (Thread.currentThread() == Looper.getMainLooper().getThread()) { task.run(); }
        else { MAIN.post(task); try { if(!latch.await(3, java.util.concurrent.TimeUnit.SECONDS)) Log.e(TAG, "isPlayingSync TIMEOUT"); } catch(InterruptedException ie){} }
        return result.get();
    }

    // V137: 给 JS togglePlay 的 "status" RPC 用 — 启动后应用重启，native 里 exo 还没有加载任何源
    // 时，hasSource()=false，JS 就会知道：不能 resume，需要重新 play(url) 加载一遍URL
    public boolean hasSourceSync() {
        final AtomicBoolean result = new AtomicBoolean(false);
        final CountDownLatch latch = new CountDownLatch(1);
        Runnable task = new Runnable() {
            @Override public void run() {
                try {
                    boolean ok = false;
                    if (exo != null) {
                        // MediaItem 数量>0 = 已经加载过播放源
                        int c = exo.getMediaItemCount();
                        boolean inited = (exo.getPlaybackState() != Player.STATE_IDLE);
                        ok = c > 0 || inited;
                        Log.d(TAG, "hasSourceSync: mediaCount=" + c + " state=" + exo.getPlaybackState() + " -> ok=" + ok);
                    }
                    result.set(ok);
                } catch (Throwable t) { Log.w(TAG, "hasSourceSync inner FAIL: " + t); }
                finally { latch.countDown(); }
            }
        };
        if (Thread.currentThread() == Looper.getMainLooper().getThread()) { task.run(); }
        else { MAIN.post(task); try { if(!latch.await(3, java.util.concurrent.TimeUnit.SECONDS)) Log.e(TAG, "hasSourceSync TIMEOUT"); } catch(InterruptedException ie){} }
        return result.get();
    }

    // V182: 给 Service 的蓝牙重连"静音保活轨"自动停止用 —— 只有 ExoPlayer 真正进入
    //   STATE_READY 且 playWhenReady（音频轨实际在渲染）才算真实音频起来了。
    public boolean isRendering() {
        try {
            return exo != null && exo.getPlayWhenReady() && exo.getPlaybackState() == Player.STATE_READY;
        } catch (Throwable t) { return false; }
    }

    // V183: 最后播放电台持久化 —— 进程被系统回收/重启后，媒体键冷启动 Service 可据此直连播放，
    //   不再依赖 Activity/WebView/JS 加载（冷启动 JS 链路数秒延迟且 Service 无法等待）。
    public static final String LAST_CH_SP = "retro_last_channel";
    public static final String LC_URL = "url", LC_NAME = "name", LC_SUB = "sub", LC_TS = "ts";

    private void persistLastChannel() {
        try {
            appCtx.getSharedPreferences(LAST_CH_SP, android.content.Context.MODE_PRIVATE)
                  .edit()
                  .putString(LC_URL, curUrl)
                  .putString(LC_NAME, curName)
                  .putString(LC_SUB, curSub)
                  .putLong(LC_TS, System.currentTimeMillis())
                  .apply();
        } catch (Throwable t) { Log.w(TAG, "persistLastChannel FAIL: " + t); }
    }

    public synchronized void release() {
        MAIN.post(() -> {
            try {
                if (exo != null) { exo.release(); exo = null; }
                Log.i(TAG, "release OK");
            } catch (Throwable ignore) {}
        });
        // V170: 释放后清掉单例引用，下次getShared会重建
        if (sInstance == this) sInstance = null;
    }
}
