package com.retro.radio;

import android.app.AlarmManager; // V188-B: 等待期90秒精确闹钟兜底自检
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
    // V185: 蓝牙断开暂停时立即释放全部播放锁。旧版等30s/2min Runnable释放，但断开后进程立刻
    //   被HANS冻结、Handler积压：实测20:47断开→22:02解冻才release，PARTIAL_WAKE_LOCK+FULL
    //   WifiLock名义持有75分钟 → 触发ColorOS"异常耗电"告警(22:10)。蓝牙断开期间无需保护任何
    //   流(已暂停)，FGS身份保留即可(无锁无流量≈零耗电且防冻结)。
    private void releaseAllLocksImmediatelyForBtPause() {
        try { powerHandler.removeCallbacks(pauseDemoteHighPerf); powerHandler.removeCallbacks(pauseDemoteFgs); } catch (Throwable ignore) {}
        try { if (wifiLock != null && wifiLock.isHeld()) { wifiLock.release(); Log.i(TAG, "V185-POWER: BT pause → immediate release HIGH_PERF WifiLock"); } } catch (Throwable ignore) {}
        try { if (wakeLock != null && wakeLock.isHeld()) { wakeLock.release(); Log.i(TAG, "V185-POWER: BT pause → immediate release PARTIAL_WAKE_LOCK"); } } catch (Throwable ignore) {}
        try { if (wifiLockFull != null && wifiLockFull.isHeld()) { wifiLockFull.release(); Log.i(TAG, "V185-POWER: BT pause → immediate release FULL WifiLock"); } } catch (Throwable ignore) {}
    }

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
    // V186: 等待态静音轨模式。实测(20260913 08:12)：耳机关机整夜后再开机，audioserver 的设备
    //   回调只给 binder 事务级微解冻(default_unfreezeForKernel)，post 给主线程的任务排队不跑，
    //   广播也被 HANS 延迟到亮屏(LcdOn)才投递 → 不亮屏永不自动恢复。V182静音轨只在重连确认的
    //   几十秒存在，等待的整夜没有任何 audio-active 身份 → 被冻。V186：蓝牙断开时(确有播放意愿)
    //   即启动【无限等待静音轨】，不持 wakelock/wifilock、不走网络，仅一条 MIN_PRIORITY 线程写零，
    //   AudioFlinger 据此判 uid 音频活跃 → HANS 整夜不冻 → 重连回调在主线程正常执行 → 自动出声。
    private volatile boolean btWaitSilenceMode = false;
    // V189: 屏幕状态接收器。等待轨只在【息屏+蓝牙断开】时运行；亮屏时系统不会冻进程/断网，
    //   等待轨纯耗电(实测约0.61%/8h)。亮屏即停、息屏即启，白天蓝牙断开但亮屏时零额外耗电。
    private BroadcastReceiver screenReceiver = null;
    // V190: 息屏后延迟启动等待轨，双时段。
    //   白天[08:00,21:00)：实测(20260918)息屏37/63分钟无等待轨，白名单单独即可让蓝牙回调直达，
    //   故延迟45分钟——白天短息屏(看时间/回消息/短会)等待轨零运行零耗电；
    //   夜间[21:00,08:00)：2分钟。系统约21:42起SENSING→约20分钟后进DEEP_SLEEP，
    //   必须保证deepSleep静音判定那一刻±16LSB轨已在跑(mIsPlayMusic=true保网)。
    //   边界：傍晚布防若45min会跨过21:00，则提前到"21:00+2min"启动，不赌跨窗。
    private static final long BT_SILENCE_DELAY_DAY_MS = 45 * 60 * 1000L;
    private static final long BT_SILENCE_DELAY_NIGHT_MS = 2 * 60 * 1000L;
    private static final int DAY_START_HOUR = 8;
    private static final int NIGHT_START_HOUR = 21;
    private final android.os.Handler silenceStartHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable silenceStartRunnable = new Runnable() {
        @Override public void run() { doStartBtSilenceKeepalive(); }
    };
    private static final String STABILITY_SP = "retro_stability";
    private static final String KEY_BT_WAIT_INTENT = "bt_wait_intent_v186";
    private static final long BT_SILENCE_MAX_MS = 45000L; // V184: 15s→45s（蜂窝网prepare慢；必须等到新流真实出声）
    private static final int BT_SILENCE_SAMPLE_RATE = 16000;
    // V188-B: 等待期精确闹钟兜底。实测(20260915 06:20/06:44，Android 16 / V.276532a)：App后台长冻结
    //   后开箱，NOISY广播被系统扣押不投递(DEFER_BY_OPLUS SUB_REASON: FROZEN)，audioserver设备回调
    //   也不给解冻 —— V187"开箱回调里重建静音轨"的前提(回调能执行)在新系统上不成立，整夜哑掉。
    //   对策：等待期间每90秒 setExactAndAllowWhileIdle 自唤醒一次(HANS日志证实alarm可解冻冻结应用：
    //   freeze记账含 ua_alarm/up_BC，闹钟是OEM白名单能力)。醒来若音箱已连→立即恢复(最差分钟级出声，
    //   绝不整夜哑)；未连→刷新近静音轨保住 audio-active 身份再睡。Doze深睡下 allow-while-idle 有
    //   每App约9分钟节流，兜底周期退化为~9分钟，仍远好于整夜无声。
    private static final long BT_WAIT_ALARM_INTERVAL_MS = 90000L;
    private static final int BT_WAIT_ALARM_RC = 10086;
    private static final String ACTION_BT_WAIT_ALARM = "com.retro.radio.BT_WAIT_ALARM";
    public static final String ACTION_BT_WAIT_REARM = "com.retro.radio.BT_WAIT_REARM"; // V188-C: 开机自启恢复等待态
    private PendingIntent btWaitAlarmPi = null;
    private BroadcastReceiver btWaitAlarmReceiver = null;

    /** 供 Activity 回前台时查询蓝牙断开态，同步 JS 标志/UI（后台期间发生的断开）。 */
    public boolean isBtAudioDisconnected() { return btAudioDisconnected; }

    // V186: 持久化"蓝牙等待播放意愿"（断连时在播 → 耳机回来要自动续）。进程若被系统杀死后
    //   START_STICKY/媒体事件重启，onCreate 据此重新布防（无输出→等，有输出→直接恢复）。
    public static void persistBtWaitIntent(Context ctx, boolean on) {
        try {
            ctx.getSharedPreferences(STABILITY_SP, MODE_PRIVATE)
                    .edit().putBoolean(KEY_BT_WAIT_INTENT, on).apply();
        } catch (Throwable ignore) {}
    }
    public static boolean peekBtWaitIntent(Context ctx) {
        try {
            return ctx.getSharedPreferences(STABILITY_SP, MODE_PRIVATE)
                    .getBoolean(KEY_BT_WAIT_INTENT, false);
        } catch (Throwable t) { return false; }
    }
    private void setBtWaitIntent(boolean on) {
        persistBtWaitIntent(getApplicationContext(), on);
        Log.i(TAG, "V186 wait-intent = " + on);
    }

    /** V186: 用户在 UI 上手动暂停 → 放弃整夜等待（耳机再连也不自动续）。供 RPC pause 调用。 */
    public void userManualPauseClearsBtWait() {
        // V186 双保险：noisy 断连后 5 秒内到达的 pause 一律视为断开流程的内部镜像
        //   （JS handleBtAudioDisconnect 注入执行有时序延迟），绝不撤防；真实用户操作
        //   不可能与断连事件在同一 5 秒窗口内精确重合。
        if (lastBtNoisyElapsed > 0L
                && SystemClock.elapsedRealtime() - lastBtNoisyElapsed < 5000L) {
            Log.i(TAG, "V186: pause within 5s after noisy → treat as auto mirror, keep wait mode");
            return;
        }
        if (btWaitSilenceMode || peekBtWaitIntent(getApplicationContext())) {
            Log.i(TAG, "V186: user manual pause → disarm wait mode/intent");
            setBtWaitIntent(false);
            stopBtWaitSilence();
        }
    }

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
        // V189: 屏幕状态监听——息屏才启动等待轨，亮屏即停，避免白天蓝牙断开时长时间空转耗电。
        try {
            screenReceiver = new BroadcastReceiver() {
                @Override public void onReceive(Context context, Intent intent) {
                    String a = intent == null ? null : intent.getAction();
                    if (Intent.ACTION_SCREEN_OFF.equals(a)) {
                        // 息屏：若处于等待态，调度等待轨(双时段延迟，跳过白天短息屏)
                        if (btWaitSilenceMode && !btSilenceRunning) {
                            startBtSilenceKeepalive();
                            Log.i(TAG, "V190 screen-OFF: schedule keepalive (dual-phase delay, wait-mode)");
                        }
                    } else if (Intent.ACTION_SCREEN_ON.equals(a)) {
                        // 亮屏：取消延迟+停止等待轨，亮屏不会冻进程
                        if (btSilenceRunning) {
                            stopBtSilenceKeepalive();
                            Log.i(TAG, "V189 screen-ON: stop keepalive (screen interactive, no freeze risk)");
                        }
                    }
                }
            };
            IntentFilter sf = new IntentFilter();
            sf.addAction(Intent.ACTION_SCREEN_OFF);
            sf.addAction(Intent.ACTION_SCREEN_ON);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(screenReceiver, sf, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(screenReceiver, sf);
            }
        } catch (Throwable t) { Log.w(TAG, "V189 register screenReceiver FAIL: " + t); }
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
                    // V184: 不只通知JS（实测JS有15s throttle且"is playing/buffering"会skip，
                    //   数据网onLost后TCP静默挂死时永远救不回来）→ Java层直接判定并重建卡住的播放
                    try {
                        NativeAudioPlayer p = NativeAudioPlayer.peekInstance();
                        if (p != null) p.forceReLiveFromNetwork();
                    } catch (Throwable ignore) {}
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
                case ACTION_BT_WAIT_REARM:
                    // V188-C: 开机自启。Service冷启动时 onCreate→registerBtAudioMonitor 已按
                    //   持久化等待意图完成布防(无输出→等待静音+闹钟；有输出→3秒确认恢复)，
                    //   这里只需记录，不做额外动作（绝不在开机时贸然 handlePlay）。
                    Log.i(TAG, "V188: BOOT re-arm start received; wait-intent handled at create");
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

    private void directResumePlayerIfHasSource() { directResumePlayerIfHasSource(false); }

    // V191: btAuto=true 表示由蓝牙设备接入自动恢复（非用户按键）。此路径在真正让 ExoPlayer
    //   出声前必须确认外部 sink 仍在 —— 手机喇叭绝不允许自动播放（用户安全红线/V183门控初衷）。
    private void directResumePlayerIfHasSource(boolean btAuto) {
        try {
            NativeAudioPlayer p = NativeAudioPlayer.peekInstance();
            if (p == null) {
                // V183: 进程刚被媒体键冷启动（系统回收/force-stop/装更新后），单例尚不存在。
                //   旧逻辑直接return + 广播给JS，但Activity/WebView都没起 → 死路无声。
                //   改为读持久化的最后电台URL，在Java层直起ExoPlayer播放；之后用户点开app，
                //   JS init 的 status 检查会发现isPlaying=true并同步UI（V170 BOOT路径）。
                coldStartPlayLastChannel(btAuto);
                return;
            }
            // V185: 防重复恢复。实测蓝牙耳机A2DP重连后会自动补发AVCRP PLAY键(约重连后20秒)，
            //   与我们的蓝牙恢复形成双路径：第二次resumeLive会把刚恢复正常的流强行seekTo+prepare
            //   重来一次 → 用户感知"卡顿一下/播着播着又缓冲"。已在播放/缓冲恢复中则直接忽略。
            if (p.isPlayingN()) {
                Log.i(TAG, "V185 directResume: player already playing/buffering (resumeLive done or AVCRP dup key) → skip");
                return;
            }
            // 有源(暂停/锁屏期间ExoPlayer保留media item) → V184蓝牙恢复一律重建直播流(resumeLive)；
            //   无源 → 同样尝试最后电台URL直连
            if (p.hasSourceSync()) {
                if (btAuto && !hasExternalAudioOutput()) {
                    Log.i(TAG, "V191 directResume: sink gone before resumeLive → abort (never use speaker)");
                    return;
                }
                Log.i(TAG, "V184 directResume: resumeLive (seekTo live edge+prepare, never resume stale conn)");
                p.resumeLive();
            } else {
                Log.d(TAG, "V177 directResume: no source, try V183 cold-start last channel");
                coldStartPlayLastChannel(btAuto);
            }
        } catch (Throwable t) { Log.w(TAG, "V177 directResume FAIL: " + t); }
    }

    // V183: 用持久化的最后电台直连播放（媒体键冷启动唯一可靠路径，不依赖JS）
    private void coldStartPlayLastChannel() { coldStartPlayLastChannel(false); }

    // V191: requireExternalOutput=true（蓝牙自动恢复）时，playUrl 前必须再次确认外部 sink 在线。
    private void coldStartPlayLastChannel(final boolean requireExternalOutput) {
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
                        // V191: 蓝牙自动恢复（非用户按键）冷路径 —— playUrl 前再次确认外部 sink 在线，
                        //   子线程与 Runnable 之间有窗口，设备可能已消失；绝不允许漏到手机喇叭。
                        if (requireExternalOutput && !hasExternalAudioOutputStatic(appCtx0)) {
                            Log.i(TAG, "V191 coldStart: external sink gone before playUrl → abort (never play on speaker)");
                            return;
                        }
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
        if (notifyUi) {
            // V186: 通知栏/媒体键/ACTION_PAUSE 属用户主动暂停 → 放弃蓝牙整夜等待
            userManualPauseClearsBtWait();
        }
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
        stopBtWaitSilence();       // V186: 用户主动停止 → 撤整夜等待静音
        setBtWaitIntent(false);    // V186: 清除等待意愿（耳机再连也不自动续）
        btAudioDisconnected = false;
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
                            // V186: 断连瞬间先抓 Service 侧播放态（pauseForBt→handlePause 之后会变 false）。
                            //   仅"断连时确实在播"才布整夜等待；用户本来就手动暂停着 → 不布防、不自动续。
                            final boolean wasPlayingBeforeNoisy = isPlaying;
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
                            releaseAllLocksImmediatelyForBtPause();  // V185: 立即释放全部锁(防冻结积压名义长持触发耗电告警)
                            repromoteFgsForBtConfirm(); // V182: 若此前用户手动暂停已降级FGS，此刻补提（防等待期被冻）
                            sendBroadcastToUI(ACTION_BT_DISCONNECTED);
                            // V186: 整夜等待静音轨 —— 耳机回来前进程必须保持 audio-active 不被HANS冻
                            if (wasPlayingBeforeNoisy) {
                                setBtWaitIntent(true);
                                startBtWaitSilence();
                            } else {
                                Log.i(TAG, "V186: noisy while not playing -> do NOT arm wait-silence/intent");
                            }
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
                                // V186: 确认窗口内设备又消失(弱信号抖动/二次关机)，若仍有等待意愿，
                                //   回到整夜等待态(保持 audio-active 不被冻)
                                if (peekBtWaitIntent(getApplicationContext())) startBtWaitSilence();
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
            // V186: 进程被杀后重启(START_STICKY等)，若断连等待意愿仍在：无输出→重新进入整夜等待静音；
            //   已有输出(耳机在进程死亡期间已连回)→直接走3秒确认恢复。
            // V191: 等待意图不在（睡前手动暂停/停止）但持久化有最后电台：同样允许外部 sink 接入即
            //   自动续播。有输出→直接恢复；无输出→不启动等待轨/闹钟（低耗电），onAudioDevicesAdded
            //   事件到来时 scheduleBtRestore 的 V191 门控会放行（回调靠 deviceidle 白名单直达）。
            try {
                if (peekBtWaitIntent(getApplicationContext())) {
                    if (hasExternalAudioOutput()) {
                        btAudioDisconnected = true;
                        Log.i(TAG, "V186: wait-intent found at create + external output present → restore directly");
                        scheduleBtRestore();
                    } else {
                        btAudioDisconnected = true;
                        Log.i(TAG, "V186: wait-intent found at create, no output → re-arm wait-silence");
                        startBtWaitSilence();
                    }
                } else if (hasPlayableChannelForAutoResume()) {
                    if (hasExternalAudioOutput()) {
                        Log.i(TAG, "V191: last channel at create + external sink present → restore directly");
                        scheduleBtRestore();
                    } else {
                        Log.i(TAG, "V191: last channel at create, no external sink → idle, auto-resume when any sink added");
                    }
                }
            } catch (Throwable t) { Log.w(TAG, "V186 create re-arm FAIL: " + t); }
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
    // V189: 仅做调度——亮屏不启动、息屏延迟启动；实际AudioTrack创建在doStartBtSilenceKeepalive。
    /** V190: 按当前时刻计算息屏延迟（白天45min/夜间2min/傍晚跨窗取短）。 */
    private long currentBtSilenceDelayMs() {
        java.util.Calendar c = java.util.Calendar.getInstance();
        int h = c.get(java.util.Calendar.HOUR_OF_DAY);
        if (h >= NIGHT_START_HOUR || h < DAY_START_HOUR) return BT_SILENCE_DELAY_NIGHT_MS;
        java.util.Calendar nightStart = (java.util.Calendar) c.clone();
        nightStart.set(java.util.Calendar.HOUR_OF_DAY, NIGHT_START_HOUR);
        nightStart.set(java.util.Calendar.MINUTE, 0);
        nightStart.set(java.util.Calendar.SECOND, 0);
        nightStart.set(java.util.Calendar.MILLISECOND, 0);
        long msToNight = nightStart.getTimeInMillis() - c.getTimeInMillis();
        return Math.min(BT_SILENCE_DELAY_DAY_MS, msToNight + BT_SILENCE_DELAY_NIGHT_MS);
    }

    private void startBtSilenceKeepalive() {
        try {
            if (btSilenceRunning) return;
            silenceStartHandler.removeCallbacks(silenceStartRunnable);
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null && pm.isInteractive()) {
                // 亮屏：不启动，等息屏后由screenReceiver重新调度
                Log.i(TAG, "V190 keepalive: deferred (screen ON, will arm after SCREEN_OFF)");
                return;
            }
            // 息屏：按双时段延迟启动，跳过白天短息屏空转；夜间2min保证deepSleep前在轨
            long delay = currentBtSilenceDelayMs();
            silenceStartHandler.postDelayed(silenceStartRunnable, delay);
            Log.i(TAG, "V190 keepalive: scheduled start in " + (delay/1000) + "s (screen OFF, dual-phase)");
        } catch (Throwable t) { Log.w(TAG, "V189 keepalive schedule FAIL: " + t); }
    }

    /** 真正创建并启动等待轨 AudioTrack（被延迟Runnable或重建路径调用）。 */
    private void doStartBtSilenceKeepalive() {
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
            // V188-A: 不再 setVolume(0)。实测(20260915)：Android16 升级后"PCM全零+音量0"的纯静音轨
            //   会被音频系统静音检测/Atlas判定为无声，audio-active 身份逐渐失效，长冻结后开箱不再解冻。
            // V189(20260917)：±2LSB(-84dBFS)能过HANS冻结，却过不了ColorOS电池(deepSleep)独立静音检测
            //   (日志 mIsSilenceAudioOut=true → 睡眠窗整机断网)。升级为随机弱噪声：
            //   峰值-66dBFS(±16LSB)、RMS约-71dBFS，无固定音调(宽带随机)、统计零直流；
            //   每轮写入重新生成，避免短周期重复。音量保持默认1.0。
            //   (±32LSB/-60dBFS 在部分蓝牙音箱上可闻嘶嘶声，降为±16LSB)。
            t.setVolume(1.0f);
            t.play();
            btSilenceTrack = t;
            btSilenceRunning = true;
            final byte[] nearSilent = new byte[bufSize];
            btSilenceThread = new Thread(new Runnable() {
                @Override public void run() {
                    AudioTrack tr = btSilenceTrack;
                    java.util.Random rnd = new java.util.Random();
                    try {
                        while (btSilenceRunning && tr != null) {
                            // ±16 LSB 对称均匀分布随机噪声：nextInt(33)-16 ∈ [-16,16]，little-endian 16bit
                            for (int i = 0; i < nearSilent.length; i += 2) {
                                int s = rnd.nextInt(33) - 16;
                                nearSilent[i] = (byte) (s & 0xFF);
                                nearSilent[i + 1] = (byte) ((s >> 8) & 0xFF);
                            }
                            tr.write(nearSilent, 0, nearSilent.length); // 阻塞写，保持track活跃(V189: ±16LSB随机弱噪声)
                        }
                    } catch (Throwable ignored) {}
                }
            }, "BtSilenceKeepalive");
            btSilenceThread.setPriority(Thread.MIN_PRIORITY);
            btSilenceThread.start();
            Log.i(TAG, "V189 keepalive: NEAR-SILENT track started (±16LSB random noise, anti-freeze + anti-mute-detect)");
        } catch (Throwable t) { Log.w(TAG, "V182 keepalive start FAIL: " + t); stopBtSilenceKeepalive(); }
    }

    private void stopBtSilenceKeepalive() {
        silenceStartHandler.removeCallbacks(silenceStartRunnable); // V189: 取消尚未触发的延迟启动
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

    // V187: 强制重建静音轨。实测(20260913 12:04，冻结约1小时后开箱)：旧 AudioTrack 在
    //   AudioFlinger 侧已被 OPPO Atlas 静音检测判定休眠（App 内对象仍在 PLAY），重连解冻窗口
    //   仅约3秒，旧轨重路由不再产生 audio_track_create/noteAudio 事件 → 系统不授
    //   STATUS_AUDIO_FOCUS 免冻身份 → 3秒后重新冻结，3秒确认任务被积压129秒才出声。
    //   对策：设备添加回调里第一时间销毁旧轨并全新建一条 —— 新轨 createTrack+start 本身即触发
    //   notifyAudioTrackCreate + noteAudio(start=true)（11:02/12:06 两次实证），配合整夜持有未放的
    //   audioFocus，使 HANS 判定 importance=audioFocus 挡住再冻。内容仍全零、音量0，绝不出声。
    private void restartBtSilenceTrackFresh() {
        try {
            boolean wasArmed = btSilenceRunning;
            stopBtSilenceKeepalive();
            // V189: 重建需立即生效(获取fresh audio focus)，不走2分钟延迟；亮屏则无需重建。
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null && !pm.isInteractive()) {
                doStartBtSilenceKeepalive();
            }
            Log.i(TAG, "V187 keepalive: silence track RECREATED fresh on restore trigger (wasArmed=" + wasArmed + ")");
        } catch (Throwable t) { Log.w(TAG, "V187 fresh silence restart FAIL: " + t); }
    }

    // V186: 无限等待静音轨（耳机长时间关机期间）。与确认窗口共用同一条 AudioTrack（start 幂等），
    //   区别只在于：不挂任何 45s 自动停止检查，直到重连后真实流出声(scheduleSilenceAutoStop)或
    //   用户 stop/销毁才释放。零音量、零网络、零 wifilock/wakelock，开销仅 MIN_PRIORITY 写零线程。
    //   V188: ①内容升级为近静音非零PCM(见startBtSilenceKeepalive注释)；②挂90秒精确闹钟兜底自检
    //   (Android16长冻结后开箱事件不再投递，闹钟是唯一可靠的定时自醒通道，见字段注释)。
    //   V189: 近静音内容再升级为±32LSB随机弱噪声，同时骗过ColorOS deepSleep静音检测避免睡眠窗断网。
    private void startBtWaitSilence() {
        try {
            cancelSilenceAutoStop();  // 等待态不允许残留的限时检查提前撤防
            startBtSilenceKeepalive();
            btWaitSilenceMode = true;
            startBtWaitAlarm();
            Log.i(TAG, "V188 wait-silence: ARMED indefinitely until BT reconnect (near-silent + 90s alarm self-check)");
        } catch (Throwable t) { Log.w(TAG, "V186 startBtWaitSilence FAIL: " + t); }
    }

    private void stopBtWaitSilence() {
        btWaitSilenceMode = false;
        stopBtSilenceKeepalive();
        stopBtWaitAlarm();  // V188: 等待撤防→闹钟链一并停(handleStop/手动暂停/onDestroy/真实出声都走这里)
    }

    // ==================== V188-B: 等待期闹钟兜底自检 ====================
    /** 布防闹钟自检链（幂等：receiver已在则只重排下一次）。 */
    private void startBtWaitAlarm() {
        try {
            if (btWaitAlarmReceiver == null) {
                btWaitAlarmReceiver = new BroadcastReceiver() {
                    @Override public void onReceive(Context context, Intent intent) {
                        handleBtWaitAlarmFire();
                    }
                };
                IntentFilter f = new IntentFilter(ACTION_BT_WAIT_ALARM);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    registerReceiver(btWaitAlarmReceiver, f, Context.RECEIVER_NOT_EXPORTED);
                } else {
                    registerReceiver(btWaitAlarmReceiver, f);
                }
            }
            armNextBtWaitAlarm();
            Log.i(TAG, "V188 wait-alarm: armed (interval=" + BT_WAIT_ALARM_INTERVAL_MS + "ms)");
        } catch (Throwable t) { Log.w(TAG, "V188 wait-alarm arm FAIL: " + t); }
    }

    private void armNextBtWaitAlarm() {
        try {
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            if (btWaitAlarmPi == null) {
                Intent it = new Intent(ACTION_BT_WAIT_ALARM).setPackage(getPackageName());
                btWaitAlarmPi = PendingIntent.getBroadcast(this, BT_WAIT_ALARM_RC, it,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            }
            long trigger = SystemClock.elapsedRealtime() + BT_WAIT_ALARM_INTERVAL_MS;
            boolean exact = true;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                try { exact = am.canScheduleExactAlarms(); } catch (Throwable ignore) {}
            }
            if (exact) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, btWaitAlarmPi);
            } else {
                // SCHEDULE_EXACT_ALARM 未授予(可引导用户在设置里开)：退化为非精确，Doze下有~9min节流
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, btWaitAlarmPi);
            }
            Log.i(TAG, "V188 wait-alarm: next fire in " + BT_WAIT_ALARM_INTERVAL_MS + "ms (exact=" + exact + ")");
        } catch (Throwable t) { Log.w(TAG, "V188 wait-alarm schedule FAIL: " + t); }
    }

    private void handleBtWaitAlarmFire() {
        try {
            if (!btWaitSilenceMode && !peekBtWaitIntent(getApplicationContext())) {
                Log.i(TAG, "V188 wait-alarm: wait intent gone → stop self-check chain");
                stopBtWaitAlarm();
                return;
            }
            boolean hasOut = hasExternalAudioOutput();
            Log.i(TAG, "V188 wait-alarm: FIRED, externalOutput=" + hasOut + " (frozen-recovery self-check)");
            if (hasOut) {
                // 音箱已在进程睡眠期间连回：闹钟唤醒本身就是解冻窗口，立即走标准恢复
                // (3秒确认锁+FGS + directResume；V190起恢复路径不再重建等待轨)
                btAudioDisconnected = true;
                btRestoreDelayMs = BT_RESTORE_BASE_MS;
                scheduleBtRestore();
                // scheduleBtRestore 成功路径由 scheduleSilenceAutoStop 撤防；若异常其 finally 也会
                // startBtWaitSilence 重新挂闹钟，此处不再重复排程，避免双链
            } else {
                // 仍未连接：睡下一轮。V190：息屏宽限期内(延迟Runnable仍在队列)不重建等待轨，
                //   纯靠白名单+闹钟测无轨基线；宽限期后才刷新近静音轨维持 audio-active 身份。
                if (silenceStartHandler.hasCallbacks(silenceStartRunnable)) {
                    Log.i(TAG, "V190 wait-alarm: FIRED in grace window (no track) -> skip rebuild, reschedule");
                } else {
                    restartBtSilenceTrackFresh();
                }
                armNextBtWaitAlarm();
            }
        } catch (Throwable t) {
            Log.w(TAG, "V188 wait-alarm fire err: " + t);
            try { armNextBtWaitAlarm(); } catch (Throwable ignore) {}
        }
    }

    private void stopBtWaitAlarm() {
        try {
            if (btWaitAlarmPi != null) {
                AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
                if (am != null) am.cancel(btWaitAlarmPi);
            }
        } catch (Throwable ignore) {}
        try { if (btWaitAlarmReceiver != null) unregisterReceiver(btWaitAlarmReceiver); } catch (Throwable ignore) {}
        btWaitAlarmReceiver = null;
        Log.i(TAG, "V188 wait-alarm: disarmed");
    }

    // ExoPlayer 真实流渲染后立即释放静音轨；45s 不起也兜底释放。
    //   requireBuffering=true(蓝牙resumeLive恢复)：必须先观察到BUFFERING再READY+position推进2秒
    //   requireBuffering=false(watchdog/网络重建)：重建动作本身就是seekTo+prepare，不可能是旧死
    //     连接，BUFFERING可能<800ms被采样错过(实测多保活40秒)，只看READY+position推进即可
    private void scheduleSilenceAutoStop(final boolean requireBuffering) {
        try { if (btSilenceStopCheck != null) btHandler.removeCallbacks(btSilenceStopCheck); } catch (Throwable ignore) {}
        final long startElapsed = SystemClock.elapsedRealtime();
        // V184: 释放条件收紧。旧版见STATE_READY就释放，但resume旧死连接时ExoPlayer一直READY、
        //   吐的是几十秒本地旧缓冲，静音轨提前释放→HANS重新冻结→随后真卡死无人救。
        //   新判定：随后进入 READY 且 position连续2秒(5次x400ms采样)真实增长，才认为新流真出声；
        //   45秒兜底。
        final boolean[] sawBuffering = {false};
        final long[] advBasePos = {-1L};
        final int[] advTicks = {0};
        btSilenceStopCheck = new Runnable() {
            @Override public void run() {
                boolean reallyAudible = false;
                int state = -99;
                long pos = -1L;
                try {
                    NativeAudioPlayer p = NativeAudioPlayer.peekInstance();
                    if (p != null) {
                        state = p.getPlaybackStateInt();
                        pos = p.getCurrentPositionMs();
                        if (state == 2 /*STATE_BUFFERING*/) sawBuffering[0] = true;  // Player.STATE_BUFFERING=2
                        boolean bufferingGatePassed = !requireBuffering || sawBuffering[0];
                        if (state == 3 /*STATE_READY*/ && bufferingGatePassed) {
                            if (advBasePos[0] < 0L) {
                                advBasePos[0] = pos; advTicks[0] = 0;
                            } else if (pos > advBasePos[0]) {
                                advTicks[0]++;
                                if (advTicks[0] >= 5) reallyAudible = true;  // 连续2秒position增长
                            }
                        }
                    }
                } catch (Throwable ignore) {}
                long waited = SystemClock.elapsedRealtime() - startElapsed;
                if (reallyAudible) {
                    Log.i(TAG, "V185 keepalive: READY and position advancing 2s (reqBuf=" + requireBuffering + ") -> release silence");
                    btSilenceStopCheck = null;
                    if (btWaitSilenceMode || peekBtWaitIntent(getApplicationContext())) {
                        // V186: 等待态下终于真实出声 → 撤整夜布防
                        Log.i(TAG, "V186: stream really audible after BT wait -> disarm wait mode");
                        setBtWaitIntent(false);
                        stopBtWaitSilence();
                    } else {
                        stopBtSilenceKeepalive();
                    }
                } else if (waited >= BT_SILENCE_MAX_MS) {
                    Log.w(TAG, "V185 keepalive: new stream not really audible in " + BT_SILENCE_MAX_MS
                            + "ms (state=" + state + " pos=" + pos + " sawBuf=" + sawBuffering[0] + ") -> release anyway (watchdog still guards)");
                    btSilenceStopCheck = null;
                    if (btWaitSilenceMode) {
                        // V186: 等待态45s没出声，不撤防也不重置检查(检查器已结束)，保持整夜静音防冻结，
                        //   后续设备/网络/watchdog事件会再触发恢复；仅记录
                        Log.w(TAG, "V186: wait mode silence retained after 45s inaudible (still anti-HANS armed)");
                    } else {
                        stopBtSilenceKeepalive();
                    }
                } else {
                    btHandler.postDelayed(this, 400L);
                }
            }
        };
        btHandler.postDelayed(btSilenceStopCheck, requireBuffering ? 800L : 400L);
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

    /**
     * V191: 是否存在"可被外部设备接入自动唤起"的播放源。
     *   热路径：ExoPlayer 单例还在且保留 media item（睡前手动暂停、进程未死）；
     *   冷路径：进程重建后单例无源/不存在，但 retro_last_channel 里有最后播放的电台 URL。
     *   从未播放过（无持久化电台）→ false，任何情况下都不自动响。
     */
    private boolean hasPlayableChannelForAutoResume() {
        try {
            NativeAudioPlayer p = NativeAudioPlayer.peekInstance();
            if (p != null && p.hasSourceSync()) return true;
            android.content.SharedPreferences sp =
                    getSharedPreferences(NativeAudioPlayer.LAST_CH_SP, MODE_PRIVATE);
            String url = sp.getString(NativeAudioPlayer.LC_URL, "");
            return url != null && !url.isEmpty();
        } catch (Throwable t) {
            Log.w(TAG, "V191 hasPlayableChannel FAIL: " + t);
            return false;
        }
    }

    private void scheduleBtRestore() {
        try {
            if (!btAudioDisconnected) {
                // V191: 用户策略"任何外部音箱接入都自动恢复最后播放的台"。旧版仅
                //   NOISY/V183 布防态(btAudioDisconnected=true)才恢复 → 睡前手动暂停过夜，
                //   早上开音箱被此门控挡掉（实测20260920，日志仅有"延迟确认"无恢复）。
                NativeAudioPlayer _qp = NativeAudioPlayer.peekInstance();
                if (isPlaying && _qp != null && _qp.isPlayingN()) {
                    // 正在播放（手机喇叭/旧设备）时新 sink 加入：系统会自动 reroute 音频，
                    //   我们什么都不用做，避免无谓的确认锁/FGS提升和二次 resumeLive。
                    Log.i(TAG, "V191: sink added while already playing → system auto-routes, skip");
                    return;
                }
                if (!hasPlayableChannelForAutoResume()) return;
                Log.i(TAG, "V191: sink added in paused state with playable channel → auto-resume armed");
            }
            cancelScheduledBtRestore();  // 清掉旧任务并释放旧锁
            // V190: 不再在此重建等待轨。V187 零音量时代需要 fresh noteAudio 抢解冻窗口身份；
            //   V189 起 ±16LSB 轨在轨即被系统认作音乐(mIsPlayMusic=true)，重建纯属多余且产生开箱
            //   前2-3秒嘶嘶声。现状：夜间轨在跑→保留到READY后释放；白天宽限期没跑→靠下面的
            //   确认锁(btRestoreWakeLock)+FGS提升完成3秒确认，回调能直达本身说明进程未被深冻。
            final long delay = btRestoreDelayMs;
            acquireBtConfirmLock(delay); // V180: 保住确认窗口的CPU，保证息屏/Doze下Runnable准时执行
            repromoteFgsForBtConfirm();  // V182: FGS身份兜底
            btRestoreRunnable = new Runnable() {
                @Override public void run() {
                    btRestoreRunnable = null;
                    boolean restored = false;
                    try {
                        // V191: 非蓝牙断开态也允许恢复（手动暂停后外部 sink 接入），前提是仍有可播源
                        if (!btAudioDisconnected && !hasPlayableChannelForAutoResume()) {
                            stopBtSilenceKeepalive();
                            return;
                        }
                        if (!hasExternalAudioOutput()) {
                            Log.i(TAG, "[V180-BT] 延迟" + delay + "ms后外部输出已不在（抖动），放弃恢复");
                            cancelSilenceAutoStop();
                            // V186: 等待态下设备确认时又消失 → 回整夜等待，不撤静音防冻结
                            if (peekBtWaitIntent(getApplicationContext())) startBtWaitSilence();
                            else stopBtSilenceKeepalive();
                            return;
                        }
                        Log.i(TAG, "[V180-BT] 设备稳定在线 " + delay + "ms → FGS直连恢复播放");
                        btAudioDisconnected = false;
                        // V191: btAuto=true —— 蓝牙自动恢复路径，冷启动子线程 playUrl 前再次
                        //   确认外部 sink 仍在，防止确认窗口后设备消失导致声音从手机喇叭漏出。
                        directResumePlayerIfHasSource(true);  // 内部含V179长暂停重新prepare
                        sendBroadcastToUI(ACTION_BT_RECONNECTED);
                        restored = true;
                        // 静音轨继续保留直到 ExoPlayer 真实流 STATE_READY（prepare 建连期间仍可能被HANS判定不可感知）
                        // V186: 等待态(整夜)恢复走的是全量 setMediaItem 重建，物理上不可能接旧死连接，
                        //   其 BUFFERING 实测仅 338ms，800ms 后首采样必然错过 → 旧严格门控导致静音轨
                        //   45秒撤不掉、与真实流双轨并跑浪费电。等待态只要求 READY+position 连续推进；
                        //   普通确认窗口(seekTo+prepare)保持"先见BUFFERING"严格门控防死连接假READY。
                        boolean waitMode = btWaitSilenceMode || peekBtWaitIntent(getApplicationContext());
                        scheduleSilenceAutoStop(!waitMode);
                    } catch (Throwable t) { Log.w(TAG, "[V180-BT] restore runnable err: " + t); }
                    finally {
                        releaseBtConfirmLock();
                        if (!restored) {
                            cancelSilenceAutoStop();
                            // V186: 恢复异常时等待态继续整夜布防，非等待态才释放静音轨
                            if (peekBtWaitIntent(getApplicationContext())) startBtWaitSilence();
                            else stopBtSilenceKeepalive();
                        }
                    }
                }
            };
            btHandler.postDelayed(btRestoreRunnable, delay);
            Log.i(TAG, "[V180-BT] 检测到外部输出，延迟 " + delay + "ms 确认后恢复（已持确认锁）");
        } catch (Throwable t) {
            Log.w(TAG, "[V180-BT] schedule err: " + t);
            releaseBtConfirmLock();
            cancelSilenceAutoStop();
            // V186: 排程异常时，等待态继续保留静音轨(整夜布防不能因一次异常撤防)；非等待态才释放
            if (peekBtWaitIntent(getApplicationContext())) startBtWaitSilence();
            else stopBtSilenceKeepalive();
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
        // V186: 不再在这里无条件停静音轨 —— 整夜等待态要跨"取消挂起恢复"存活（noisy/设备二次消失）。
        //   显式撤防只在 handleStop / onDestroy(unregisterBtAudioMonitor) / 真实流出声(auto-stop)。
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

    // V184: Native层watchdog/网络恢复触发播放重建时调用。重建prepare期间（蜂窝网可能十几秒）
    //   进程无声 → HANS可能重新冻结 → 重建必然失败。若当前有外部音频输出，启动静音轨保活直到
    //   新流真实出声（position推进）；扬声器场景(前台在听)不需要。
    public void notifyRebuildKeepalive() {
        try {
            if (!hasExternalAudioOutput()) {
                Log.i(TAG, "V184 rebuild keepalive: no external output (speaker/foreground), skip");
                return;
            }
            startBtSilenceKeepalive();
            scheduleSilenceAutoStop(false);  // V185: watchdog重建本身=新prepare,不强制等BUFFERING(避免多保活40秒)
            Log.i(TAG, "V184 rebuild keepalive: silence track armed until new stream really renders");
        } catch (Throwable t) { Log.w(TAG, "V184 notifyRebuildKeepalive FAIL: " + t); }
    }

    private void unregisterBtAudioMonitor() {
        cancelScheduledBtRestore();
        stopBtWaitSilence();  // V186: 注销/销毁显式撤静音轨（等待意图保留，进程重启可再布防）
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
        try { if (screenReceiver != null) unregisterReceiver(screenReceiver); } catch (Throwable ignore) {}
        unregisterSvcNetworkReconnect();
        unregisterBtAudioMonitor();
        try { if (mediaSession != null) { mediaSession.setActive(false); mediaSession.release(); } } catch (Throwable ignore) {}
        releaseLocks();
        abandonAudioFocus();
        try { notificationManager.cancel(NOTIFICATION_ID); } catch (Throwable ignore) {}
        super.onDestroy();
    }
}
