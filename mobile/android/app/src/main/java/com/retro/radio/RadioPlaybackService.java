package com.retro.radio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothDevice;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.wifi.WifiManager;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import java.util.Locale;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.util.Log;
import android.view.KeyEvent;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media.session.MediaButtonReceiver;

public class RadioPlaybackService extends Service implements AudioManager.OnAudioFocusChangeListener {

    public static final String CHANNEL_ID = "radio_playback_channel";
    public static final int NOTIFICATION_ID = 1001;
    public static final String ACTION_PLAY = "com.retro.radio.PLAY";
    public static final String ACTION_PAUSE = "com.retro.radio.PAUSE";
    public static final String ACTION_STOP = "com.retro.radio.STOP";
    public static final String ACTION_TOGGLE = "com.retro.radio.TOGGLE";
    public static final String ACTION_NEXT = "com.retro.radio.NEXT";
    public static final String ACTION_PREV = "com.retro.radio.PREV";
    public static final String ACTION_META = "com.retro.radio.META";
    public static final String ACTION_ERROR = "com.retro.radio.ERROR";
    public static final String ACTION_RECONNECT = "com.retro.radio.RECONNECT"; // V152 网络恢复重连
    public static final String ACTION_BT_DISCONNECTED = "com.retro.radio.BT_DISC"; // V180 蓝牙音频断开(通知UI)
    public static final String ACTION_BT_RECONNECTED  = "com.retro.radio.BT_RECONN"; // V180 蓝牙音频恢复(通知UI)
    public static final String EXTRA_NAME = "name";
    public static final String EXTRA_SUBTITLE = "subtitle";
    public static final String EXTRA_IS_PLAYING = "isPlaying";
    public static final String EXTRA_URL = "url";

    private static final String WAKE_TAG = "RadioPlaybackService::WakeLock";
    private static final String WIFI_TAG = "RadioPlaybackService::WifiLock";
    private static final String TAG = "RetroRadioSvc";

    private MediaSessionCompat mediaSession;
    private PlaybackStateCompat.Builder stateBuilder;
    private NotificationManager notificationManager;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private WifiManager.WifiLock wifiLockFull; // V102 ADD: WIFI_MODE_FULL (不可剥夺基础锁，HIGH_PERF可被系统剥夺，2把锁双保险)

    // V159 功耗优化：暂停时延迟降级HIGH_PERF WifiLock + FGS最高优先级
    private static final long PAUSE_DEMOTE_HIGH_PERF_DELAY_MS = 30_000L;   // 暂停30秒后释放HIGH_PERF WifiLock（仅留FULL基础锁）
    private static final long PAUSE_DEMOTE_FGS_DELAY_MS        = 2 * 60_000L; // 暂停2分钟后降级FGS（stopForeground(DETACH)，Notification仍在）
    private final Runnable pauseDemoteHighPerf = new Runnable() {
        @Override public void run() {
            if (isPlaying) return; // 在延迟期间用户恢复播放了，不再降级
            try { if (wifiLock != null && wifiLock.isHeld()) { wifiLock.release(); Log.i(TAG, "V159-POWER: paused 30s, released HIGH_PERF WifiLock (kept FULL lock)"); } } catch (Throwable ignore) {}
        }
    };
    private final Runnable pauseDemoteFgs = new Runnable() {
        @Override public void run() {
            if (isPlaying) return;
            // V182 FIX: 蓝牙断开导致的暂停，绝不降级FGS。
            //   实锤：降级后 oom_adj=450 进程被 ColorOS cgroup freezer 整体挂起（PARTIAL_WAKE_LOCK
            //   也挡不住厂商冻结，唤醒锁只防Doze CPU休眠），重连回调虽短暂解冻投递，但 postDelayed
            //   的3秒确认Runnable随进程再次冻结永不执行 → 耳机重连不自动恢复。
            //   保留FGS身份（不持任何唤醒/WiFi锁、无流量）本身几乎零耗电，却能让进程留在免冻结区间。
            if (btAudioDisconnected) {
                Log.i(TAG, "V182-POWER: paused 2min but BT disconnected -> keep FGS (anti-freeze), still release locks");
            } else {
                try { stopForeground(STOP_FOREGROUND_DETACH); Log.i(TAG, "V159-POWER: paused 2min, demoted FGS (detach, notification kept)"); }
                catch (Throwable t1) { try { stopForeground(false); } catch (Throwable ignore) {} }
                // 降级后仍显示Notification（FGS降级≠普通Service，但前台优先级较低从而省电）
                try { notificationManager.notify(NOTIFICATION_ID, buildNotification()); } catch (Throwable ignore) {}
            }
            // V164 POWER: 暂停2分钟后基础锁也释放。PARTIAL_WAKE_LOCK常驻会让CPU永不深睡，是待机耗电大头。
            //   暂停状态下没有流需要保护；用户恢复播放时 handlePlay/acquireLocks 会重新拿全部锁。
            try { if (wakeLock != null && wakeLock.isHeld()) { wakeLock.release(); Log.i(TAG, "V164-POWER: paused 2min, released PARTIAL_WAKE_LOCK"); } } catch (Throwable ignore) {}
            try { if (wifiLockFull != null && wifiLockFull.isHeld()) { wifiLockFull.release(); Log.i(TAG, "V164-POWER: paused 2min, released FULL WifiLock"); } } catch (Throwable ignore) {}
        }
    };
    private final android.os.Handler powerHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private boolean hasFocus = false;
    private boolean isPlaying = false;
    // V152 网络切换自动重连：Service 层双保险监听（Activity 后台冻结时仍有效）
    private ConnectivityManager.NetworkCallback svcNetworkCallback = null;
    private volatile boolean svcLastNetAvailable = true;
    private String channelName = "";
    private String channelSubtitle = "";
    private long lastHandledTs = 0;
    private int lastHandledCode = -1;

    // =========================================================
    // V180 蓝牙音频监听（从 Activity 迁移到 Service）
    //   根因：监听原挂在 Activity，app 切后台后 ColorOS 冻结/销毁 Activity，receiver 与
    //   AudioDeviceCallback 都收不到回调；而 ExoPlayer setHandleAudioBecomingNoisy(true)
    //   仍会自动暂停音频 → btAudioDisconnected 标志没置位 → 重连被门控挡住不恢复。
    //   前台 Service 进程持有 FGS，后台同样可靠收到广播/设备回调，故整体迁移至此。
    // =========================================================
    private volatile boolean btAudioDisconnected = false;
    private BroadcastReceiver btAudioReceiver = null;
    private AudioDeviceCallback btAudioDeviceCallback = null;
    private final Handler btHandler = new Handler(Looper.getMainLooper());
    private Runnable btRestoreRunnable = null;
    private long btRestoreDelayMs = BT_RESTORE_BASE_MS;
    private long lastBtNoisyElapsed = 0L;
    private static final long BT_RESTORE_BASE_MS = 3000L;
    private static final long BT_RESTORE_MAX_MS = 15000L;
    private static final long BT_JITTER_WINDOW_MS = 15000L;  // 15s内再次断开=抖动中
    private static final long BT_STABLE_RESET_MS = 30000L;   // 断开间隔>30s=曾稳定，延迟重置
    // V180 FIX(后台10分钟重连不恢复实锤): 暂停2min后 V164 已释放 PARTIAL_WAKE_LOCK+降级FGS。
    //   重连时 onAudioDevicesAdded 靠系统binder能唤醒主线程一次，但 postDelayed(3s) 的确认任务
    //   会因 CPU 重回深度休眠被无限推迟 → "设备稳定→恢复" 永不执行（日志 09:35:21 后无下文）。
    //   方案：仅在"等待重连确认"这几秒内临时持一把限时 PARTIAL_WAKE_LOCK，保证确认Runnable准时跑；
    //   确认结束(恢复/取消/超时兜底)立即释放。暂停的十几分钟仍不持锁，不影响 V164 省电。
    private PowerManager.WakeLock btRestoreWakeLock = null;

    // V182 FIX(HANS冻结实锤): OPPO HANS 冻结器在息屏后冻结"非可感知"进程 —— 即使持有FGS(adj 200)
    //   和 PARTIAL_WAKE_LOCK 也照冻，且冻结时强制释放我们的唤醒锁(OplusProxyWakeLock FroceReleaseWakeLock)。
    //   蓝牙重连只给 ~3秒 AsyncBinder 解冻窗口，3秒确认Runnable到期时进程已被重新冻结 → 永不恢复。
    //   方案：重连确认窗口启动一条零音量静音 AudioTrack —— AudioFlinger 视 uid 为"音频活跃"=可感知，
    //   HANS 不再冻结 → ExoPlayer 从容 prepare 建连；真实流 STATE_READY 后立刻释放静音轨。
    //   只在重连后几秒内存在；暂停等待的十几分钟零持有，不增加耗电。
    private AudioTrack btSilenceTrack = null;
    private Thread btSilenceThread = null;
    private volatile boolean btSilenceRunning = false;
    private Runnable btSilenceStopCheck = null;
    private static final long BT_SILENCE_MAX_MS = 15000L; // 真实流迟迟不起，15s兜底释放
    private static final int BT_SILENCE_SAMPLE_RATE = 16000;

    /** 供 Activity 回前台时查询蓝牙断开态，同步 JS 标志/UI（后台期间发生的断开）。 */
    public boolean isBtAudioDisconnected() { return btAudioDisconnected; }

    private final IBinder binder = new LocalBinder();
    public static volatile RadioPlaybackService sLastInstance = null;

    public class LocalBinder extends Binder {
        public RadioPlaybackService getService() {
            return RadioPlaybackService.this;
        }
    }

    /** Called by NativeAudioPlayer (Java-to-Java) directly via LocalBinder path, bypassing startService/onStartCommand.
     *  These update MediaSession/Foreground/Locks without broadcasting to JS (to avoid re-triggering playUrl again).
     */
    public void apiPlayFromBinder(String name, String sub, boolean acquireFocus) {
        if (name != null && !name.isEmpty()) { channelName = name; }
        if (sub != null) { channelSubtitle = sub; }
        boolean needStart = !isPlaying;
        isPlaying = true;
        if (acquireFocus) requestAudioFocus();
        acquireLocks();
        // V100: NativeAudioPlayer calls this from @JavascriptInterface directly.
        // Must call Service.startForeground(int, Notification) directly (no zero-arg wrapper existed in V82 code).
        try { startForeground(NOTIFICATION_ID, buildNotification()); }
        catch (Throwable t) { Log.w(TAG, "apiPlayFromBinder startForeground() call failed: " + t); }
        stateBuilder.setState(PlaybackStateCompat.STATE_PLAYING, 0, 1.0f);
        try { mediaSession.setPlaybackState(stateBuilder.build()); } catch (Throwable ignore) {}
        try { mediaSession.setActive(true); } catch (Throwable ignore) {}
        updateNotification();
        if (needStart) Log.d(TAG, "apiPlayFromBinder: state=PLAYING name=["+channelName+"]");
    }
    public void apiMetaFromBinder(String name, String sub, boolean playing) {
        if (name != null && !name.isEmpty()) channelName = name;
        if (sub != null) channelSubtitle = sub;
        // V160 FIX: Binder路径也要触发handlePause，否则降级Timer永远不注册
        if (!playing && isPlaying) {
            handlePause(false);  // 内部会设isPlaying=false + 注册降级Timer
        } else if (!playing) {
            this.isPlaying = false;
            updateNotification();
        } else {
            updateNotification();
        }
    }
    public void apiStopFromBinder() {
        handleStop(true);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sLastInstance = this;
        Log.d(TAG, "V102 TRIPLE-HAMMER onCreate: START - IMMEDIATELY acquire locks + startForeground + MediaSession STATE_PLAYING");
        notificationManager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
        createNotificationChannel();
        initMediaSession();
        initLocks();
        // ============ V159 POWER: onCreate只拿基础锁（省电），HIGH_PERF只在真正播放时才升级获取 ============
        //  基础锁:
        //    - PARTIAL_WAKE_LOCK: 保证CPU不进入深度休眠（保持Service处理网络回调的能力）
        //    - WIFI_MODE_FULL:    保证Wi-Fi不扫描休眠（但不强制最高性能，相对省电）
        //  昂贵锁:
        //    - WIFI_MODE_FULL_HIGH_PERF: 仅在handlePlay时升级拿，暂停30秒后释放。
        //                                 HIGH_PERF会让Wi-Fi芯片始终维持最高吞吐，明显费电。
        //  V102的Triple-Hammer改为"基础双锁+HIGH_PERF按需升级"的折中方案，避免160s无声回归同时降低待机功耗。
        try { if (!wakeLock.isHeld()) { wakeLock.acquire(); Log.d(TAG, "V159 onCreate: PARTIAL_WAKE_LOCK ACQUIRED (base lock)"); } } catch (Throwable t) { Log.w(TAG, "V159 onCreate wakeLock FAIL: "+t); }
        try { if (!wifiLockFull.isHeld()) { wifiLockFull.acquire(); Log.d(TAG, "V159 onCreate: WIFI_MODE_FULL ACQUIRED (base lock, undeprivable)"); } } catch (Throwable t) { Log.w(TAG, "V159 onCreate wifiLock(FULL) FAIL: "+t); }
        // HIGH_PERF 在handlePlay再拿，这里跳过省电
        // wifiLock(HIGH_PERF): DEFERRED → handlePlay acquire on demand
        // ============ V175 HAMMER #1: onCreate保持 MediaSession STATE_PAUSED + startForeground ============
        //  FGS保活(startForeground+锁+setActive+全部actions)全部保留，但状态用诚实的 STATE_PAUSED：
        //  Service可能在冷启动(未播放任何电台)时就被创建，此时谎报STATE_PLAYING会导致蓝牙音箱/系统媒体键
        //  误以为在播放→按播放键不触发onPlay()→ExoPlayer拿不到URL→无声(显示播放)。
        //  真实播放由 handlePlay/apiPlayFromBinder 切 STATE_PLAYING（T+160s保护在播放期间依然有效）。
        stateBuilder.setState(PlaybackStateCompat.STATE_PAUSED, 0, 1.0f);
        try { mediaSession.setPlaybackState(stateBuilder.build()); } catch (Throwable t) { Log.w(TAG, "V175 onCreate mediaSession setPlaybackState(STATE_PAUSED) FAIL: "+t); }
        try { mediaSession.setActive(true); } catch (Throwable ignore) {}
        // 立刻startForeground，不等用户点播放！（这是FGS保活设计，Notification显示"等待播放中"）
        try {
            startForeground(NOTIFICATION_ID, buildNotification());
            Log.d(TAG, "V102 onCreate: startForeground() EXECUTED (immediate at Service creation, not deferred to playUrl)");
        } catch (Throwable t) { Log.wtf(TAG, "V102 onCreate startForeground() FATAL FAIL: "+t, t); }
        // ============ V102 BONUS: 尝试告诉AMS不要OOM-kill我们 ============
        try {
            android.app.ActivityManager am = (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
            // 反射调用setProcessLimit (如果ROM暴露了这个API)
            try {
                java.lang.reflect.Method m = am.getClass().getMethod("setProcessLimit", int.class);
                m.invoke(am, 99999999);
                Log.d(TAG, "V102 onCreate: setProcessLimit(99999999) OK (AMS won't OOM-kill us)");
            } catch (Throwable ignore) { Log.d(TAG, "V102 onCreate: setProcessLimit not available (not critical)"); }
        } catch (Throwable ignore) {}
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(uiReceiver, new IntentFilter(UI_ACTION_UPDATE), Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(uiReceiver, new IntentFilter(UI_ACTION_UPDATE));
        }
        Log.d(TAG, "V102 TRIPLE-HAMMER onCreate: DONE - All 3 hammers deployed at Service creation");
        // V152 网络切换自动重连：Service 层注册网络监听（前台服务保护，不易被冻结）
        try { registerSvcNetworkReconnect(); } catch (Throwable t) { Log.w(TAG, "registerSvcNetworkReconnect FAIL: " + t); }
        // V180 蓝牙音频断开/重连监听：必须在 Service（FGS）注册，后台才可靠（Activity 会被冻结）
        try { registerBtAudioMonitor(); } catch (Throwable t) { Log.w(TAG, "registerBtAudioMonitor FAIL: " + t); }
    }

    /** V152: Service 层网络监听 — 网络恢复时通知 UI 重新连接播放 */
    private void registerSvcNetworkReconnect() {
        if (svcNetworkCallback != null) return;
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) { Log.w(TAG, "[SVC-NET] CM null, skip"); return; }
        NetworkRequest req = new NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build();
        svcNetworkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                // V172 FIX: onAvailable时网络往往未VALIDATED（数据流量刚连上），此时通知UI会触发
                //   playChannel打到不可用网络上→报错→反复重载。等onCapabilitiesChanged验证后再通知。
                //   注意：这里不置位svcLastNetAvailable，否则会挡住验证后的通知！
                Log.i(TAG, "[SVC-NET] onAvailable: network recovered (wait for validation)");
            }
            @Override
            public void onLost(Network network) {
                Log.w(TAG, "[SVC-NET] onLost: network lost");
                svcLastNetAvailable = false;
            }
            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                boolean hasNet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                if (hasNet && !svcLastNetAvailable) {
                    Log.i(TAG, "[SVC-NET] onCapabilitiesChanged: validated internet restored");
                    svcLastNetAvailable = true;
                    sendBroadcastToUI(ACTION_RECONNECT);
                } else if (!hasNet) {
                    svcLastNetAvailable = false;
                }
            }
        };
        cm.registerNetworkCallback(req, svcNetworkCallback);
        Log.i(TAG, "[SVC-NET] network reconnect monitor registered");
    }

    private void unregisterSvcNetworkReconnect() {
        if (svcNetworkCallback == null) return;
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) cm.unregisterNetworkCallback(svcNetworkCallback);
        } catch (Throwable t) { Log.d(TAG, "[SVC-NET] unregister: " + t); }
        svcNetworkCallback = null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.getAction() != null) {
            String action = intent.getAction();
            Log.d(TAG, "onStartCommand action=" + action
                    + " name=" + intent.getStringExtra(EXTRA_NAME)
                    + " playing=" + intent.getBooleanExtra(EXTRA_IS_PLAYING, isPlaying));
            switch (action) {
                case ACTION_PLAY:
                    handlePlay(true);
                    break;
                case ACTION_PAUSE:
                    handlePause(true);
                    break;
                case ACTION_TOGGLE:
                    if (isPlaying) handlePause(true); else handlePlay(true);
                    break;
                case ACTION_STOP:
                    handleStop(true);
                    break;
                case ACTION_NEXT:
                    sendBroadcastToUI(ACTION_NEXT);
                    break;
                case ACTION_PREV:
                    sendBroadcastToUI(ACTION_PREV);
                    break;
                case ACTION_META:
                    channelName = intent.getStringExtra(EXTRA_NAME) != null ? intent.getStringExtra(EXTRA_NAME) : channelName;
                    channelSubtitle = intent.getStringExtra(EXTRA_SUBTITLE) != null ? intent.getStringExtra(EXTRA_SUBTITLE) : channelSubtitle;
                    boolean playing = intent.getBooleanExtra(EXTRA_IS_PLAYING, isPlaying);
                    updateMetadata();
                    // NOTE: ACTION_META is a status report FROM JS/Web engine back to Service.
                    // We must NOT broadcast PLAY/PAUSE back to JS - this causes an infinite race:
                    // JS reportMeta(playing=true) → Service handlePlay → broadcast PLAY → JS audio.play()
                    // JS play() rejects immediately → JS reportMeta(playing=false) → Service handlePause
                    // → broadcast PAUSE → JS audio.pause() → INTERRUPTS the still-pending play() promise!
                    if (playing && !isPlaying) handlePlay(false);  // internal state update only, no UI broadcast
                    else if (!playing && isPlaying) handlePause(false);
                    else updateNotification();
                    break;
                default:
                    MediaButtonReceiver.handleIntent(mediaSession, intent);
                    break;
            }
        }
        return START_STICKY;
    }

    private void initMediaSession() {
        mediaSession = new MediaSessionCompat(this, "RetroRadioMediaSession");
        // V101 FIX: MIRROR com.xiaoxuanfeng.ILoveRadio (小旋风收音机) MediaSession config exactly.
        //   Xiaoxuanfeng: flags=7 (FLAG_HANDLES_MEDIA_BUTTONS=1 | FLAG_HANDLES_TRANSPORT_CONTROLS=2 | FLAG_HANDLES_QUEUE_COMMANDS=4)
        //   Xiaoxuanfeng: actions=16252927 = 0xF800FF = ALL transport control actions (colorOS requires these to treat FGS as MEDIA app)
        //   Without these exact flags, ColorOS treats our FGS as "generic foreground" and OOM_adj=500+ at screen off T+180s.
        final long ALL_ACTIONS_MIRROR_XIAOXUANFENG =
                  PlaybackStateCompat.ACTION_PLAY
                | PlaybackStateCompat.ACTION_PAUSE
                | PlaybackStateCompat.ACTION_PLAY_PAUSE
                | PlaybackStateCompat.ACTION_STOP
                | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
                | PlaybackStateCompat.ACTION_REWIND
                | PlaybackStateCompat.ACTION_FAST_FORWARD
                | PlaybackStateCompat.ACTION_SEEK_TO
                | PlaybackStateCompat.ACTION_PLAY_FROM_SEARCH
                | PlaybackStateCompat.ACTION_PLAY_FROM_MEDIA_ID
                | PlaybackStateCompat.ACTION_PREPARE
                | PlaybackStateCompat.ACTION_PREPARE_FROM_SEARCH
                | PlaybackStateCompat.ACTION_PREPARE_FROM_MEDIA_ID
                | PlaybackStateCompat.ACTION_SET_PLAYBACK_SPEED
                | PlaybackStateCompat.ACTION_SET_CAPTIONING_ENABLED
                | PlaybackStateCompat.ACTION_SET_REPEAT_MODE
                | PlaybackStateCompat.ACTION_SET_SHUFFLE_MODE
                | PlaybackStateCompat.ACTION_SET_RATING;
        mediaSession.setFlags(
                MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS |
                MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS |
                MediaSessionCompat.FLAG_HANDLES_QUEUE_COMMANDS);  // flags=7  exactly match xiaoxuanfeng
        stateBuilder = new PlaybackStateCompat.Builder().setActions(ALL_ACTIONS_MIRROR_XIAOXUANFENG);
        // V175 FIX(冷启动音箱播放键无声): 初始状态必须是 STATE_PAUSED 而非 STATE_PLAYING！
        //  V102为防OOM在Service创建时谎报STATE_PLAYING，但冷启动时ExoPlayer未加载任何电台(hasSource=false)，
        //  系统/蓝牙音箱误以为"正在播放"→按音箱播放键时框架对PLAYING会话不触发onPlay()（PLAY_PAUSE被判定为
        //  "已在播放"→走pause/no-op），ExoPlayer永远拿不到playUrl → 显示播放却无声。
        //  STATE_PAUSED + setActive(true) + 全部actions：系统仍视其为活跃媒体App（媒体键照常路由过来），
        //  且按播放键→框架判定"已暂停"→触发onPlay()→handlePlay广播PLAY→JS playChannel → 正常出声。
        //  真实播放时 handlePlay/apiPlayFromBinder 会立刻切 STATE_PLAYING，V102的T+160s保护不受影响。
        //  （历史教训：绝不能用STATE_NONE→系统不认为是媒体App→OOM_adj升高；STATE_PAUSED是"就绪未播放"的诚实态）
        stateBuilder.setState(PlaybackStateCompat.STATE_PAUSED, 0, 1.0f);
        mediaSession.setPlaybackState(stateBuilder.build());
        // V101 FIX: setActive(true) IMMEDIATELY, not lazily. Xiaoxuanfeng does this at Service.onCreate.
        try { mediaSession.setActive(true); } catch (Throwable ignore) {}
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { handlePlay(true); }
            @Override public void onPause() { handlePause(true); }
            @Override public void onStop() { handleStop(true); }
            @Override public void onSkipToNext() {
                try { if (mediaSession != null) mediaSession.setActive(true); } catch (Throwable ignore) {}
                sendBroadcastToUI(ACTION_NEXT);
                refreshStateAfterAction();
            }
            @Override public void onSkipToPrevious() {
                try { if (mediaSession != null) mediaSession.setActive(true); } catch (Throwable ignore) {}
                sendBroadcastToUI(ACTION_PREV);
                refreshStateAfterAction();
            }
            @Override public boolean onMediaButtonEvent(Intent mediaButtonEvent) {
                KeyEvent key = mediaButtonEvent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                if (key == null) return super.onMediaButtonEvent(mediaButtonEvent);
                int action = key.getAction();
                if (action != KeyEvent.ACTION_DOWN && action != KeyEvent.ACTION_UP) {
                    return super.onMediaButtonEvent(mediaButtonEvent);
                }
                int code = key.getKeyCode();
                long now = System.currentTimeMillis();
                boolean shouldHandle = true;
                if (code == lastHandledCode && (now - lastHandledTs) < 300) {
                    shouldHandle = false;
                }
                if (!shouldHandle) return true;
                try { if (mediaSession != null) mediaSession.setActive(true); } catch (Throwable ignore) {}
                boolean isMediaKey = false;
                if (code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || code == KeyEvent.KEYCODE_HEADSETHOOK) {
                    isMediaKey = true;
                    if (isPlaying) handlePause(true); else handlePlay(true);
                } else if (code == KeyEvent.KEYCODE_MEDIA_PLAY) {
                    isMediaKey = true; handlePlay(true);
                } else if (code == KeyEvent.KEYCODE_MEDIA_PAUSE) {
                    isMediaKey = true; handlePause(true);
                } else if (code == KeyEvent.KEYCODE_MEDIA_STOP) {
                    isMediaKey = true; handleStop(true);
                } else if (code == KeyEvent.KEYCODE_MEDIA_NEXT) {
                    isMediaKey = true;
                    sendBroadcastToUI(ACTION_NEXT);
                    refreshStateAfterAction();
                } else if (code == KeyEvent.KEYCODE_MEDIA_PREVIOUS) {
                    isMediaKey = true;
                    sendBroadcastToUI(ACTION_PREV);
                    refreshStateAfterAction();
                }
                if (isMediaKey) {
                    lastHandledTs = now;
                    lastHandledCode = code;
                    return true;
                }
                return super.onMediaButtonEvent(mediaButtonEvent);
            }
        });
        mediaSession.setActive(true);
    }

    private void initLocks() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_TAG);
        wakeLock.setReferenceCounted(false);
        // V180: 蓝牙重连确认窗口专用短锁（非计数，限时acquire兜底防泄漏）
        try {
            btRestoreWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RadioBtRestore::Confirm");
            btRestoreWakeLock.setReferenceCounted(false);
        } catch (Throwable t) { Log.w(TAG, "initLocks: btRestoreWakeLock create FAIL: " + t); }

        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, WIFI_TAG);
        wifiLock.setReferenceCounted(false);
        // V102 ADD: WIFI_MODE_FULL 基础锁 (不可被系统剥夺，HIGH_PERF锁在ColorOS电池优化下可能被系统强制释放)
        //  小旋风收音机: 2把锁都持有，即使HIGH_PERF被剥夺，WIFI_MODE_FULL依然能保证WiFi不进入休眠
        try {
            wifiLockFull = wm.createWifiLock(WifiManager.WIFI_MODE_FULL, WIFI_TAG + "::FULL");
            wifiLockFull.setReferenceCounted(false);
        } catch (Throwable t) { Log.w(TAG, "initLocks: WIFI_MODE_FULL create FAIL (rare): "+t);
            // Fallback: 如果ROM不支持单独FULL锁，就复用HIGH_PERF锁引用
            wifiLockFull = wifiLock;
        }
    }

    public void loadAndPlay(String url, boolean autoStart) {
        Log.d(TAG, "loadAndPlay called but Service is in MediaSession-only mode; ignoring URL=" + url
                + ". Web Audio engine should be used instead.");
    }

    private boolean requestAudioFocus() {
        if (hasFocus) return true;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                                .build())
                        .setOnAudioFocusChangeListener(this)
                        .setWillPauseWhenDucked(true)
                        .build();
                hasFocus = audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
            } else {
                hasFocus = audioManager.requestAudioFocus(this, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
            }
        } catch (Throwable t) { hasFocus = false; }
        return hasFocus;
    }

    private void abandonAudioFocus() {
        if (!hasFocus) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
                audioManager.abandonAudioFocusRequest(focusRequest);
            } else {
                audioManager.abandonAudioFocus(this);
            }
        } catch (Throwable ignore) {}
        hasFocus = false;
    }

    private void acquireLocks() {
        try { if (!wakeLock.isHeld()) wakeLock.acquire(); } catch (Throwable ignore) {}
        // V159: WIFI_MODE_FULL 是基础锁，onCreate时已拿到无需重复
        try { if (wifiLockFull != null && !wifiLockFull.isHeld()) wifiLockFull.acquire(); } catch (Throwable ignore) {}
        // V159: HIGH_PERF 是昂贵高性能锁 → 只有在真播放时才拿（如果已经拿到就不要再拿，避免引用计数变化）
        try { if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire(); } catch (Throwable ignore) {}
    }

    private void releaseLocks() {
        // V159: releaseLocks只在handleStop/onDestroy调用，暂停时不调用releaseLocks（保持基础锁）
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Throwable ignore) {}
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Throwable ignore) {}
        try { if (wifiLockFull != null && wifiLockFull.isHeld()) wifiLockFull.release(); } catch (Throwable ignore) {}
    }

    // V177: 媒体键/通知栏的播放暂停，必须在 Java/Service 层直接操控 ExoPlayer 单例。
    //   旧链路 handlePlay/handlePause 只 sendBroadcastToUI → 靠 Activity 的 receiver → evaluateJavascript
    //   → JS → nativeAudioRpc 才能真正暂停/恢复 ExoPlayer。但锁屏长时间后 ColorOS 会销毁 Activity(V170 onDestroy)，
    //   receiver 随之注销、WebView 消失 → 广播无人接收 → ExoPlayer 永远收不到暂停(继续响)或恢复。
    //   这里直接调进程级单例：即使 Activity 已死，ExoPlayer(归属进程+Service) 照常受控。
    private void directPausePlayer() {
        try {
            NativeAudioPlayer p = NativeAudioPlayer.peekInstance();
            if (p != null) {
                Log.i(TAG, "V177 directPausePlayer: pausing ExoPlayer singleton (Activity may be dead)");
                p.pause();  // 普通外部暂停(媒体键/通知栏)；内部走 ACTION_META/apiMetaFromBinder，不广播 → 无回环
            } else {
                Log.d(TAG, "V177 directPausePlayer: no player singleton (nothing to pause)");
            }
        } catch (Throwable t) { Log.w(TAG, "V177 directPausePlayer FAIL: " + t); }
    }

    private void directResumePlayerIfHasSource() {
        try {
            NativeAudioPlayer p = NativeAudioPlayer.peekInstance();
            if (p == null) {
                // V183: 进程刚被媒体键冷启动（系统回收/force-stop/装更新后），单例尚不存在。
                //   旧逻辑直接return + 广播给JS，但Activity/WebView都没起 → 死路无声。
                //   改为读持久化的最后电台URL，在Java层直起ExoPlayer播放；之后用户点开app，
                //   JS init 的 status 检查会发现isPlaying=true并同步UI（V170 BOOT路径）。
                coldStartPlayLastChannel();
                return;
            }
            // 有源(暂停/锁屏期间ExoPlayer保留media item) → 直接resume；无源 → 同样尝试最后电台URL直连
            if (p.hasSourceSync()) {
                Log.i(TAG, "V177 directResume: resuming ExoPlayer singleton (has source)");
                p.resume();  // 内部走 ACTION_META/apiPlayFromBinder，不广播 → 无回环
            } else {
                Log.d(TAG, "V177 directResume: no source, try V183 cold-start last channel");
                coldStartPlayLastChannel();
            }
        } catch (Throwable t) { Log.w(TAG, "V177 directResume FAIL: " + t); }
    }

    // V183: 用持久化的最后电台直连播放（媒体键冷启动唯一可靠路径，不依赖JS）
    private void coldStartPlayLastChannel() {
        try {
            android.content.SharedPreferences sp =
                    getSharedPreferences(NativeAudioPlayer.LAST_CH_SP, MODE_PRIVATE);
            final String url = sp.getString(NativeAudioPlayer.LC_URL, "");
            final String name = sp.getString(NativeAudioPlayer.LC_NAME, "");
            final String sub = sp.getString(NativeAudioPlayer.LC_SUB, "");
            if (url == null || url.isEmpty()) {
                Log.d(TAG, "V183 coldStart: no persisted channel, nothing to play");
                return;
            }
            Log.i(TAG, "V183 coldStart: media-key wake → start ExoPlayer directly name=[" + name + "]");
            final Context appCtx0 = getApplicationContext();
            new Thread(new Runnable() {
                @Override public void run() {
                    try {
                        // 先peek：单例已存在说明Activity可能已注册JS回调，绝不能用getShared(ctx,null)
                        //   把回调清空（setEvents(null)）；仅进程冷启动真无单例时才以cb=null创建。
                        NativeAudioPlayer p = NativeAudioPlayer.peekInstance();
                        if (p == null) p = NativeAudioPlayer.getShared(appCtx0, null);
                        p.playUrlSync(url, name, sub);
                    } catch (Throwable t) { Log.w(TAG, "V183 coldStart play FAIL: " + t); }
                }
            }, "V183ColdStart").start();
        } catch (Throwable t) { Log.w(TAG, "V183 coldStart FAIL: " + t); }
    }

    private void handlePlay(boolean notifyUi) {
        if (!requestAudioFocus()) {
            Log.w(TAG, "handlePlay: AudioFocus request FAIL");
        }
        // V177 FIX(切台卡顿/播放栏失效回环): direct resume 只允许"外部入口"(notifyUi=true：
        //   媒体键 onPlay / ACTION_PLAY / ACTION_TOGGLE / 通知栏)调用 —— 这些场景 Activity 可能已死、
        //   JS 链路断裂，需要 Java 直连 ExoPlayer。
        //   notifyUi=false 来自 ACTION_META(L290)，那是 ExoPlayer 内部状态(prepare/setMediaItem/buffering)
        //   镜像回 Service 的上报，若再反过去 resume ExoPlayer 就形成"状态上报→控制播放器→再上报"的自激振荡：
        //   切台时反复 setPlayWhenReady(true/false)+翻转wantPlaying → 新台被打断卡死、播放栏标志错乱。
        if (notifyUi) directResumePlayerIfHasSource();
        // V159: 恢复播放时：先取消Pause降级Timer（避免拿到锁又被计划任务释放）
        try { powerHandler.removeCallbacks(pauseDemoteHighPerf); powerHandler.removeCallbacks(pauseDemoteFgs); } catch (Throwable ignore) {}
        acquireLocks();
        isPlaying = true;
        stateBuilder.setState(PlaybackStateCompat.STATE_PLAYING, 0, 1.0f);
        try { mediaSession.setPlaybackState(stateBuilder.build()); } catch (Throwable ignore) {}
        try { mediaSession.setActive(true); } catch (Throwable ignore) {}
        // V159: 如果暂停>2分钟时已降级FGS → 恢复播放要重新提升为真正的前台服务
        startForeground(NOTIFICATION_ID, buildNotification());
        updateNotification();
        if (notifyUi) sendBroadcastToUI(ACTION_PLAY);
        else Log.d(TAG, "V159 handlePlay: startForeground + re-acquire HIGH_PERF locks if released");
    }

    private void handlePause(boolean notifyUi) {
        // V177: 仅外部入口(notifyUi=true：媒体键/通知栏/ACTION_PAUSE/TOGGLE)才直连 ExoPlayer 暂停，
        //   覆盖锁屏后 Activity 死亡、JS 广播链路断裂的场景。
        //   notifyUi=false 是 ACTION_META 的内部状态镜像，不能反控 ExoPlayer（否则切台自激振荡卡顿，
        //   详见 handlePlay 注释）。屏幕播放栏走 RPC pause→_pauseMain→ACTION_META(false)，本就不该再 pause 一次。
        if (notifyUi) directPausePlayer();
        isPlaying = false;
        stateBuilder.setState(PlaybackStateCompat.STATE_PAUSED, 0, 1.0f);
        try { mediaSession.setPlaybackState(stateBuilder.build()); } catch (Throwable ignore) {}
        try { mediaSession.setActive(true); } catch (Throwable ignore) {}
        // V102 核心：PAUSE 不释放基础锁（PARTIAL_WAKE_LOCK + WIFI_MODE_FULL）、不stopForeground移除，
        //   避免短暂pause→WiFi休眠/FGS降级→160s无声。
        // V159 新增：计划延迟降级（不影响30秒内用户恢复，长期暂停才省电）
        //   T+30s  → 只释放HIGH_PERF WifiLock（暂停时网络流量极少，基础WIFI_MODE_FULL足矣防止Wi-Fi断流）
        //   T+2min → stopForeground(DETACH) 降级FGS（Notification仍在系统栏可见，OOM_adj比FGS低→省电）
        try {
            powerHandler.removeCallbacks(pauseDemoteHighPerf);
            powerHandler.removeCallbacks(pauseDemoteFgs);
            powerHandler.postDelayed(pauseDemoteHighPerf, PAUSE_DEMOTE_HIGH_PERF_DELAY_MS);
            powerHandler.postDelayed(pauseDemoteFgs, PAUSE_DEMOTE_FGS_DELAY_MS);
        } catch (Throwable ignore) {}
        updateNotification();
        // 注意：V159 暂停时 **绝不释放基础锁**，不abandon音频焦点（否则系统会立即让别的App抢焦点、冻结我们）
        if (notifyUi) sendBroadcastToUI(ACTION_PAUSE);
        else Log.d(TAG, "V159 handlePause: base locks retained; HIGH_PERF demoted after 30s; FGS demoted after 2min");
    }

    private long lastStopBroadcastMs = 0L;  // V167: STOP广播节流(死循环保险丝)

    private void handleStop(boolean notifyUi) {
        isPlaying = false;
        stateBuilder.setState(PlaybackStateCompat.STATE_STOPPED, 0, 1.0f);
        try { mediaSession.setPlaybackState(stateBuilder.build()); } catch (Throwable ignore) {}
        try { mediaSession.setActive(false); } catch (Throwable ignore) {}
        try { stopForeground(STOP_FOREGROUND_REMOVE); } catch (Throwable ignore) {
            try { stopForeground(true); } catch (Throwable ig) {}
        }
        try { notificationManager.cancel(NOTIFICATION_ID); } catch (Throwable ignore) {}
        releaseLocks();
        abandonAudioFocus();
        if (notifyUi) {
            // V167 保险丝: 1秒内重复STOP广播直接丢弃，防止JS层stop死循环烧CPU
            long now = android.os.SystemClock.elapsedRealtime();
            if (now - lastStopBroadcastMs < 1000L) {
                Log.w(TAG, "V167 handleStop: STOP broadcast throttled (<1s since last)");
            } else {
                lastStopBroadcastMs = now;
                sendBroadcastToUI(ACTION_STOP);
            }
        } else Log.d(TAG, "handleStop: internal state update only (skip broadcast to UI)");
        cancelSilenceAutoStop();
        stopBtSilenceKeepalive();  // V182: 停止时兜底释放静音保活轨
        stopSelf();
    }

    private void updateMetadata() {
        MediaMetadataCompat.Builder mb = new MediaMetadataCompat.Builder();
        mb.putString(MediaMetadataCompat.METADATA_KEY_TITLE, channelName.isEmpty() ? "海燕收音机" : channelName);
        mb.putString(MediaMetadataCompat.METADATA_KEY_ARTIST, channelSubtitle.isEmpty() ? "海燕收音机" : channelSubtitle);
        mb.putString(MediaMetadataCompat.METADATA_KEY_ALBUM, "海燕收音机");
        try { mediaSession.setMetadata(mb.build()); } catch (Throwable ignore) {}
    }

    private PendingIntent makeIntent(String action, int rc) {
        Intent i = new Intent(this, RadioPlaybackService.class).setAction(action);
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE : PendingIntent.FLAG_UPDATE_CURRENT;
        return PendingIntent.getService(this, rc, i, flags);
    }

    private Notification buildNotification() {
        Intent openApp = getPackageManager().getLaunchIntentForPackage(getPackageName());
        openApp.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent contentPI = PendingIntent.getActivity(this, 0, openApp, flags);

        updateMetadata();

        int toggleIcon = isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        String toggleAction = isPlaying ? ACTION_PAUSE : ACTION_PLAY;
        CharSequence toggleTitle = isPlaying ? "暂停" : "播放";

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(channelName.isEmpty() ? "复古网络收音机" : channelName)
                .setContentText(channelSubtitle.isEmpty() ? "FM RetroRadio - 在线播放" : channelSubtitle)
                .setSmallIcon(android.R.drawable.stat_notify_sdcard)
                .setOngoing(isPlaying)
                .setContentIntent(contentPI)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .setShowWhen(false)
                .setColor(0xFFFF9A3C)
                .addAction(android.R.drawable.ic_media_previous, "上一台", makeIntent(ACTION_PREV, 101))
                .addAction(toggleIcon, toggleTitle, makeIntent(toggleAction, 102))
                .addAction(android.R.drawable.ic_media_next, "下一台", makeIntent(ACTION_NEXT, 103))
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止", makeIntent(ACTION_STOP, 104));

        androidx.media.app.NotificationCompat.MediaStyle style = new androidx.media.app.NotificationCompat.MediaStyle()
                .setShowActionsInCompactView(0, 1, 2)
                .setMediaSession(mediaSession.getSessionToken());
        builder.setStyle(style);
        return builder.build();
    }

    private void updateNotification() {
        try { notificationManager.notify(NOTIFICATION_ID, buildNotification()); } catch (Throwable ignore) {}
    }

    private void refreshStateAfterAction() {
        try {
            if (mediaSession != null) {
                int st = isPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED;
                stateBuilder.setState(st, 0, 1.0f);
                mediaSession.setPlaybackState(stateBuilder.build());
                mediaSession.setActive(true);
            }
        } catch (Throwable ignore) {}
        updateNotification();
    }

    @Override
    public void onAudioFocusChange(int focusChange) {
        // NOTE (v57): This service now operates in MediaSession/Notification-only
        // mode — actual audio playback is 100% inside Chromium Web Audio /
        // HTMLAudioElement, which MANAGES ITS OWN internal audio focus per
        // AudioTrack (Android O+). Therefore we MUST NOT broadcast ACTION_PAUSE
        // back to JS on transient focus changes — these events are often
        // SPOOFED "loss-then-regain" during our own requestAudioFocus() call
        // (especially on OPPO/ColorOS). Doing so causes the EXACT "play one
        // word then stop" the user reported: JS audio.onplaying fires ->
        // reportMeta -> handlePlay -> requestAudioFocus -> fake LOSS_TRANSIENT
        // callback HERE -> sendBroadcastToUI(ACTION_PAUSE) -> JS audio.pause()
        // -> SOUND STOPS IMMEDIATELY. Bottom button worked because on a SECOND
        // play() click, hasFocus was already true so requestAudioFocus() became
        // a no-op and no fake LOSS was generated.
        switch (focusChange) {
            case AudioManager.AUDIOFOCUS_LOSS:
                // V153 FIX: 不再立即释放锁！锁屏期间其他应用抢焦点后锁被释放
                //   → 160秒后系统杀音频输出 → 冷启动crash
                //   改为只更新状态，保持锁和前台服务
                isPlaying = false;
                stateBuilder.setState(PlaybackStateCompat.STATE_PAUSED, 0, 1.0f);
                try { mediaSession.setPlaybackState(stateBuilder.build()); } catch (Throwable ignore) {}
                updateNotification();
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                // Transient loss (short notification ding, map voice nav, etc.)
                // Do NOTHING that touches the JS/Web engine. Chromium will
                // handle ducking/short-pause internally and resume when focus
                // returns. This avoids the "1 word then stop" race entirely.
                // We optionally dim the MediaSession state to BUFFERING so the
                // system UI reflects a possible short pause, but no broadcast.
                try {
                    stateBuilder.setState(PlaybackStateCompat.STATE_BUFFERING, 0, 1.0f);
                    mediaSession.setPlaybackState(stateBuilder.build());
                } catch (Throwable ignore) {}
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                // Chromium ducks AudioTrack volume on its own; nothing to do.
                break;
            case AudioManager.AUDIOFOCUS_GAIN:
                // Focus regained — refresh media session state only.
                try {
                    int st = isPlaying ? PlaybackStateCompat.STATE_PLAYING
                                       : PlaybackStateCompat.STATE_PAUSED;
                    stateBuilder.setState(st, 0, 1.0f);
                    mediaSession.setPlaybackState(stateBuilder.build());
                } catch (Throwable ignore) {}
                updateNotification();
                break;
        }
    }

    // =========================================================
    // V180 蓝牙音频断开/重连处理（Service 所有权，FGS 后台可靠）
    //   断开：ExoPlayer 自身(setHandleAudioBecomingNoisy)会静音，但标志必须由这里置位，
    //         否则重连门控 !btAudioDisconnected 会挡住自动恢复。
    //   恢复：延迟确认(弱信号防抖)后 FGS 直连 ExoPlayer resume，再广播通知 UI。
    // =========================================================
    private void registerBtAudioMonitor() {
        if (btAudioReceiver != null) return;
        try {
            btAudioReceiver = new BroadcastReceiver() {
                @Override public void onReceive(Context context, Intent intent) {
                    try {
                        String act = intent.getAction();
                        if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(act)) {
                            cancelScheduledBtRestore();
                            long nowElapsed = SystemClock.elapsedRealtime();
                            if (lastBtNoisyElapsed > 0) {
                                long gap = nowElapsed - lastBtNoisyElapsed;
                                if (gap < BT_JITTER_WINDOW_MS) {
                                    btRestoreDelayMs = Math.min(btRestoreDelayMs * 2L, BT_RESTORE_MAX_MS);
                                    Log.i(TAG, "[V180-BT] 抖动检测 gap=" + gap + "ms → 恢复确认延迟增至 " + btRestoreDelayMs + "ms");
                                } else if (gap > BT_STABLE_RESET_MS) {
                                    btRestoreDelayMs = BT_RESTORE_BASE_MS;
                                }
                            }
                            lastBtNoisyElapsed = nowElapsed;
                            btAudioDisconnected = true;
                            Log.i(TAG, "[V180-BT] AUDIO_BECOMING_NOISY → FGS直连暂停 + 置断开标志");
                            // V183: 不走directPausePlayer(那是普通外部暂停语义)，用BT专用pauseForBt —
                            //   emit带bt标记，JS不清除wasPlaying播放意愿（重连/冷启动要据此自动恢复）
                            NativeAudioPlayer _bp = NativeAudioPlayer.peekInstance();
                            if (_bp != null) _bp.pauseForBt();  // 幂等（ExoPlayer可能已自动暂停）
                            repromoteFgsForBtConfirm(); // V182: 若此前用户手动暂停已降级FGS，此刻补提（防等待期被冻）
                            sendBroadcastToUI(ACTION_BT_DISCONNECTED);
                        } else if (BluetoothDevice.ACTION_ACL_CONNECTED.equals(act)) {
                            Log.i(TAG, "[V180-BT] ACL_CONNECTED (fallback)");
                            scheduleBtRestore();
                        }
                    } catch (Throwable t) { Log.w(TAG, "[V180-BT] receiver err: " + t); }
                }
            };
            IntentFilter f = new IntentFilter();
            f.addAction(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
            f.addAction(BluetoothDevice.ACTION_ACL_CONNECTED);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(btAudioReceiver, f, Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(btAudioReceiver, f);
            }

            try {
                AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                if (am != null) {
                    btAudioDeviceCallback = new AudioDeviceCallback() {
                        @Override public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
                            if (hasExternalSink(addedDevices)) {
                                Log.i(TAG, "[V180-BT] external output added → 延迟确认");
                                scheduleBtRestore();
                            }
                        }
                        @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
                            if (hasExternalSink(removedDevices)) {
                                Log.i(TAG, "[V180-BT] external output removed → 取消挂起恢复");
                                cancelScheduledBtRestore();
                            }
                        }
                    };
                    am.registerAudioDeviceCallback(btAudioDeviceCallback, new Handler(Looper.getMainLooper()));
                }
            } catch (Throwable t) { Log.w(TAG, "[V180-BT] AudioDeviceCallback register FAIL: " + t); }
            Log.i(TAG, "registerBtAudioMonitor: registered in Service FGS (V180)");
            // V183: 消费冷启动布防标志（JS启动时"想播放但耳机未连"，Service当时可能还没bind好）
            try {
                android.content.SharedPreferences stab = getSharedPreferences("retro_stability", MODE_PRIVATE);
                if (stab.getBoolean("bt_pending_restore", false)) {
                    stab.edit().putBoolean("bt_pending_restore", false).apply();
                    if (!hasExternalAudioOutput()) {
                        btAudioDisconnected = true;
                        Log.i(TAG, "V183: consumed persisted arm flag → BT restore armed (no external output at Service create)");
                    } else {
                        Log.i(TAG, "V183: persisted arm flag ignored (external output already present)");
                    }
                }
            } catch (Throwable ignore) {}
        } catch (Throwable t) { Log.w(TAG, "registerBtAudioMonitor FAIL: " + t); }
    }

    private boolean hasExternalSink(AudioDeviceInfo[] devs) {
        if (devs == null) return false;
        for (AudioDeviceInfo d : devs) {
            if (!d.isSink()) continue;
            int t = d.getType();
            if (t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                    || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                    || t == AudioDeviceInfo.TYPE_WIRED_HEADSET
                    || t == AudioDeviceInfo.TYPE_USB_HEADSET) {
                return true;
            }
        }
        return false;
    }

    private void acquireBtConfirmLock(long delayMs) {
        try {
            if (btRestoreWakeLock != null && !btRestoreWakeLock.isHeld()) {
                // 限时 = 确认延迟 + 3s 兜底；即使 Runnable 异常未跑，系统也会自动释放，杜绝锁泄漏
                btRestoreWakeLock.acquire(delayMs + 3000L);
            }
        } catch (Throwable t) { Log.w(TAG, "[V180-BT] acquire confirm lock FAIL: " + t); }
    }

    private void releaseBtConfirmLock() {
        try { if (btRestoreWakeLock != null && btRestoreWakeLock.isHeld()) btRestoreWakeLock.release(); }
        catch (Throwable ignore) {}
    }

    // V182: 零音量静音轨保活（详见字段注释）。任何异常都不得影响蓝牙主流程。
    private void startBtSilenceKeepalive() {
        try {
            if (btSilenceRunning) return;
            final int minBuf = AudioTrack.getMinBufferSize(BT_SILENCE_SAMPLE_RATE,
                    AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
            final int bufSize = Math.max(minBuf > 0 ? minBuf : 8192, 8192);
            AudioTrack t;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build();
                AudioFormat fmt = new AudioFormat.Builder()
                        .setSampleRate(BT_SILENCE_SAMPLE_RATE)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build();
                t = new AudioTrack(attrs, fmt, bufSize, AudioTrack.MODE_STREAM, 0); // 0 = AUDIO_SESSION_ID_GENERATE
            } else {
                t = new AudioTrack(AudioManager.STREAM_MUSIC, BT_SILENCE_SAMPLE_RATE,
                        AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
                        bufSize, AudioTrack.MODE_STREAM);
            }
            if (t.getState() != AudioTrack.STATE_INITIALIZED) {
                Log.w(TAG, "V182 keepalive: AudioTrack not initialized, abort");
                try { t.release(); } catch (Throwable ignore) {}
                return;
            }
            t.setVolume(0f);  // 双保险：PCM本身全零 + 轨道音量0，绝不出声
            t.play();
            btSilenceTrack = t;
            btSilenceRunning = true;
            final byte[] zeros = new byte[bufSize]; // new 数组默认全0 = 数字静音
            btSilenceThread = new Thread(new Runnable() {
                @Override public void run() {
                    AudioTrack tr = btSilenceTrack;
                    try {
                        while (btSilenceRunning && tr != null) {
                            tr.write(zeros, 0, zeros.length); // 阻塞写，保持track活跃
                        }
                    } catch (Throwable ignored) {}
                }
            }, "BtSilenceKeepalive");
            btSilenceThread.setPriority(Thread.MIN_PRIORITY);
            btSilenceThread.start();
            Log.i(TAG, "V182 keepalive: silence AudioTrack started (anti-HANS-freeze)");
        } catch (Throwable t) { Log.w(TAG, "V182 keepalive start FAIL: " + t); stopBtSilenceKeepalive(); }
    }

    private void stopBtSilenceKeepalive() {
        btSilenceRunning = false;
        Thread th = btSilenceThread;
        if (th != null) { try { th.interrupt(); th.join(200); } catch (Throwable ignore) {} }
        btSilenceThread = null;
        AudioTrack t = btSilenceTrack;
        btSilenceTrack = null;
        if (t != null) {
            try { t.pause(); } catch (Throwable ignore) {}
            try { t.flush(); } catch (Throwable ignore) {}
            try { t.release(); } catch (Throwable ignore) {}
        }
        if (t != null) Log.i(TAG, "V182 keepalive: silence AudioTrack released");
    }

    // ExoPlayer 真实流渲染后立即释放静音轨；15s 不起也兜底释放。
    private void scheduleSilenceAutoStop() {
        try { if (btSilenceStopCheck != null) btHandler.removeCallbacks(btSilenceStopCheck); } catch (Throwable ignore) {}
        final long startElapsed = SystemClock.elapsedRealtime();
        btSilenceStopCheck = new Runnable() {
            @Override public void run() {
                boolean rendering = false;
                try {
                    NativeAudioPlayer p = NativeAudioPlayer.peekInstance();
                    rendering = p != null && p.isRendering();
                } catch (Throwable ignore) {}
                long waited = SystemClock.elapsedRealtime() - startElapsed;
                if (rendering) {
                    Log.i(TAG, "V182 keepalive: real stream STATE_READY -> release silence");
                    btSilenceStopCheck = null;
                    stopBtSilenceKeepalive();
                } else if (waited >= BT_SILENCE_MAX_MS) {
                    Log.w(TAG, "V182 keepalive: real stream not ready in " + BT_SILENCE_MAX_MS + "ms -> release silence anyway");
                    btSilenceStopCheck = null;
                    stopBtSilenceKeepalive();
                } else {
                    btHandler.postDelayed(this, 400L);
                }
            }
        };
        btHandler.postDelayed(btSilenceStopCheck, 800L); // resume后先给建连留800ms
    }

    private void cancelSilenceAutoStop() {
        try { if (btSilenceStopCheck != null) { btHandler.removeCallbacks(btSilenceStopCheck); btSilenceStopCheck = null; } } catch (Throwable ignore) {}
    }

    // V182: 重连确认窗口兜底重新提升 FGS（覆盖"先手动暂停已降级、后关耳机"边缘场景）。
    private void repromoteFgsForBtConfirm() {
        try {
            startForeground(NOTIFICATION_ID, buildNotification());
            Log.i(TAG, "V182: FGS re-promoted during BT confirm window");
        } catch (Throwable t) { Log.w(TAG, "V182 FGS repromote FAIL: " + t); }
    }

    private void scheduleBtRestore() {
        try {
            if (!btAudioDisconnected) return;
            cancelScheduledBtRestore();  // 清掉旧任务并释放旧锁
            final long delay = btRestoreDelayMs;
            acquireBtConfirmLock(delay); // V180: 保住确认窗口的CPU，保证息屏/Doze下Runnable准时执行
            startBtSilenceKeepalive();   // V182: 防HANS在3秒解冻窗口后重新冻结（关键）
            repromoteFgsForBtConfirm();  // V182: FGS身份兜底
            btRestoreRunnable = new Runnable() {
                @Override public void run() {
                    btRestoreRunnable = null;
                    boolean restored = false;
                    try {
                        if (!btAudioDisconnected) { stopBtSilenceKeepalive(); return; }
                        if (!hasExternalAudioOutput()) {
                            Log.i(TAG, "[V180-BT] 延迟" + delay + "ms后外部输出已不在（抖动），放弃恢复");
                            cancelSilenceAutoStop();
                            stopBtSilenceKeepalive();  // 设备又没了，无需继续保活
                            return;
                        }
                        Log.i(TAG, "[V180-BT] 设备稳定在线 " + delay + "ms → FGS直连恢复播放");
                        btAudioDisconnected = false;
                        directResumePlayerIfHasSource();  // 内部含V179长暂停重新prepare
                        sendBroadcastToUI(ACTION_BT_RECONNECTED);
                        restored = true;
                        // 静音轨继续保留直到 ExoPlayer 真实流 STATE_READY（prepare 建连期间仍可能被HANS判定不可感知）
                        scheduleSilenceAutoStop();
                    } catch (Throwable t) { Log.w(TAG, "[V180-BT] restore runnable err: " + t); }
                    finally {
                        releaseBtConfirmLock();
                        if (!restored) { cancelSilenceAutoStop(); stopBtSilenceKeepalive(); }
                    }
                }
            };
            btHandler.postDelayed(btRestoreRunnable, delay);
            Log.i(TAG, "[V180-BT] 检测到外部输出，延迟 " + delay + "ms 确认后恢复（已持确认锁）");
        } catch (Throwable t) {
            Log.w(TAG, "[V180-BT] schedule err: " + t);
            releaseBtConfirmLock();
            cancelSilenceAutoStop();
            stopBtSilenceKeepalive();
        }
    }

    private void cancelScheduledBtRestore() {
        try {
            if (btRestoreRunnable != null) {
                btHandler.removeCallbacks(btRestoreRunnable);
                btRestoreRunnable = null;
            }
        } catch (Throwable ignore) {}
        releaseBtConfirmLock();  // 断开/设备消失/注销 → 立即释放确认锁
        cancelSilenceAutoStop();
        stopBtSilenceKeepalive();  // V182: 同步撤掉静音保活轨
    }

    private boolean hasExternalAudioOutput() {
        return hasExternalAudioOutputStatic(getApplicationContext());
    }

    // V183: 静态版供 MainActivity JS bridge 调用（冷启动自动续播门控，判定必须与Service一致）
    public static boolean hasExternalAudioOutputStatic(Context ctx) {
        try {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return false;
            AudioDeviceInfo[] devs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
            if (devs == null) return false;
            for (AudioDeviceInfo d : devs) {
                if (!d.isSink()) continue;
                int t = d.getType();
                if (t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                        || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                        || t == AudioDeviceInfo.TYPE_WIRED_HEADSET
                        || t == AudioDeviceInfo.TYPE_USB_HEADSET) {
                    return true;
                }
            }
        } catch (Throwable ignore) {}
        return false;
    }

    // V183: JS冷启动时"上次在播放但当前无外部输出(耳机未连)"→ 布防：之后耳机一连，
    //   onAudioDevicesAdded→scheduleBtRestore 的 btAudioDisconnected 门控就能通过并自动恢复。
    //   （进程未死、用户先开app后开耳机的场景）
    public void armPendingBtRestore() {
        try {
            if (btAudioDisconnected) return;
            if (hasExternalAudioOutput()) return;  // 已有输出无需布防，JS会直接播
            btAudioDisconnected = true;
            Log.i(TAG, "V183: armed pending BT restore (wasPlaying at cold start, no external output yet)");
        } catch (Throwable t) { Log.w(TAG, "V183 armPendingBtRestore FAIL: " + t); }
    }

    private void unregisterBtAudioMonitor() {
        cancelScheduledBtRestore();
        try { if (btAudioReceiver != null) unregisterReceiver(btAudioReceiver); } catch (Throwable t) { Log.d(TAG, "unreg btReceiver: " + t); }
        btAudioReceiver = null;
        try {
            if (btAudioDeviceCallback != null) {
                AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                if (am != null) am.unregisterAudioDeviceCallback(btAudioDeviceCallback);
            }
        } catch (Throwable t) { Log.d(TAG, "unreg btDeviceCallback: " + t); }
        btAudioDeviceCallback = null;
    }

    public static final String UI_ACTION_UPDATE = "com.retro.radio.UI";
    public static final String EXTRA_UI_EVENT = "event";

    private void sendBroadcastToUI(String event) {
        try {
            Intent i = new Intent(UI_ACTION_UPDATE);
            i.putExtra(EXTRA_UI_EVENT, event);
            sendBroadcast(i);
            Log.d(TAG, "sendBroadcastToUI event=" + event);
        } catch (Throwable t) {
            Log.w(TAG, "sendBroadcastToUI failed: " + t);
        }
    }

    private final BroadcastReceiver uiReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { }
    };

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        try {
            NotificationChannel existing = notificationManager.getNotificationChannel(CHANNEL_ID);
            if (existing != null) return;
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "收音机播放", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("后台收音机播放通知栏控制");
            channel.enableLights(true);
            channel.setLightColor(Color.rgb(255, 154, 60));
            channel.enableVibration(false);
            channel.setSound(null, null);
            channel.setShowBadge(false);
            notificationManager.createNotificationChannel(channel);
        } catch (Throwable ignore) {}
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 用户从最近任务列表划掉应用时：停止播放并清理，避免残留进程
        try {
            Log.i(TAG, "onTaskRemoved: user swiped away, stopping playback");
            handleStop(true);
            stopForeground(true);
            stopSelf();
        } catch (Throwable t) { Log.w(TAG, "onTaskRemoved err: " + t); }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        Log.d(TAG, "onDestroy");
        if (sLastInstance == this) sLastInstance = null;
        try { unregisterReceiver(uiReceiver); } catch (Throwable ignore) {}
        unregisterSvcNetworkReconnect();
        unregisterBtAudioMonitor();
        try { if (mediaSession != null) { mediaSession.setActive(false); mediaSession.release(); } } catch (Throwable ignore) {}
        releaseLocks();
        abandonAudioFocus();
        try { notificationManager.cancel(NOTIFICATION_ID); } catch (Throwable ignore) {}
        super.onDestroy();
    }
}
