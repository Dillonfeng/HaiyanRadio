package com.retro.radio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
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
    private boolean hasFocus = false;
    private boolean isPlaying = false;
    // V87d: Dynamic WifiLock management - release on cellular, re-acquire on Wi-Fi (PARTIAL_WAKE_LOCK always held during play)
    private ConnectivityManager connectivityMgr;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean networkCallbackRegistered = false;
    // Track the *current* active transport of the default network so refreshWifiLockByDefaultNetwork is idempotent.
    // -1 = unknown, 1 = WIFI, 2 = CELLULAR, 0 = none
    private int lastActiveTransport = -1;
    // V87e: All handlePlay/Pause/Stop/Meta operations MUST run serialized on MAIN Looper:
    //  - startForeground/buildNotification/stopForeground (calls into NotificationManager + RemoteViews + MediaStyle)
    //    require main thread (ColorOS 13+ throws if called from @JavascriptInterface binder pool thread)
    //  - registerNetworkCallback (2-param overload internally creates a Handler, requires caller's thread to have
    //    a Looper; @JavascriptInterface pool threads have NO Looper → crashes with "Can't create handler inside
    //    thread that has not called Looper.prepare()". That throw was being swallowed, so callback NEVER registered.)
    //  - Serialization prevents fast channel-switch races: unregister → register concurrent thrash of NetworkCallback.
    private final Handler MAIN_HANDLER = new Handler(Looper.getMainLooper());
    // V87f: Reduced debounce from 200ms → 80ms.
    // - 200ms was delaying user-visible feedback (startForeground / notification icon) long
    //   enough that the user could tap another channel and trigger a cancel+re-enqueue burst.
    // - 80ms is still large enough to collapse:
    //     a) JS __debouncedNativeNotify(120ms) → Java apiXxxFromBinder *same-key* calls that
    //        arrive 1-2ms apart from the same playChannel() frame (onplay + onplaying callbacks).
    //     b) Rapid manual taps where the user hasn't even lifted their finger yet.
    //   But small enough that the user perceives "instant" response — well below the
    //   100-150ms threshold for UI lag.
    private Runnable pendingActionRunnable = null;
    private long pendingActionTs = 0;
    private static final long PENDING_ACTION_DEBOUNCE_MS = 80L;
    // Track last dispatched meta/play/pause state to skip no-ops entirely.
    private String lastDispatchedName = "";
    private String lastDispatchedSubtitle = "";
    private boolean lastDispatchedPlaying = false;

    // V87-FIX: Binder 直调用需要的 public getter / helper
    public boolean isPlaying() { return isPlaying; }
    public void sendBroadcastToUI(String event) {
        try {
            Intent i = new Intent(UI_ACTION_UPDATE);
            i.putExtra(EXTRA_UI_EVENT, event);
            sendBroadcast(i);
            Log.e(TAG, "sendBroadcastToUI event=" + event);
        } catch (Throwable t) {
            Log.w(TAG, "sendBroadcastToUI failed: " + t);
        }
    }
    private String channelName = "";
    private String channelSubtitle = "";
    private long lastHandledTs = 0;
    private int lastHandledCode = -1;

    private final IBinder binder = new LocalBinder();

    public class LocalBinder extends Binder {
        public RadioPlaybackService getService() {
            return RadioPlaybackService.this;
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "onCreate: Web Audio engine mode - Service handles only MediaSession/Focus/Notification");
        notificationManager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
        createNotificationChannel();
        initMediaSession();
        initLocks();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(uiReceiver, new IntentFilter(UI_ACTION_UPDATE), Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(uiReceiver, new IntentFilter(UI_ACTION_UPDATE));
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.getAction() != null) {
            String action = intent.getAction();
            // V87-FIX: 升级到 ERROR level 保证 logcat 抓得到，不被任何 filter 过滤
            Log.e(TAG, "onStartCommand action=" + action
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
        mediaSession.setFlags(
                MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS |
                        MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS);
        stateBuilder = new PlaybackStateCompat.Builder()
                .setActions(
                        PlaybackStateCompat.ACTION_PLAY |
                                PlaybackStateCompat.ACTION_PAUSE |
                                PlaybackStateCompat.ACTION_PLAY_PAUSE |
                                PlaybackStateCompat.ACTION_STOP |
                                PlaybackStateCompat.ACTION_SKIP_TO_NEXT |
                                PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS);
        stateBuilder.setState(PlaybackStateCompat.STATE_NONE, 0, 1.0f);
        mediaSession.setPlaybackState(stateBuilder.build());
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

        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, WIFI_TAG);
        wifiLock.setReferenceCounted(false);

        // V87d: Pre-initialize ConnectivityManager for dynamic WifiLock management (no receivers/threads yet).
        // We register the actual NetworkCallback ONLY in handlePlay() (i.e. only while user is actually listening).
        try {
            connectivityMgr = (ConnectivityManager) getApplicationContext().getSystemService(CONNECTIVITY_SERVICE);
            buildNetworkCallback();
        } catch (Throwable t) {
            Log.e(TAG, "initLocks: connectivityMgr init FAIL (non-fatal; WifiLock will be held always): " + t);
            connectivityMgr = null;
            networkCallback = null;
        }
    }

    // V87d: Build the NetworkCallback ONCE (not on every handlePlay) - registers/unregisters cheaply.
    private void buildNetworkCallback() {
        if (networkCallback != null) return;
        try {
            networkCallback = new ConnectivityManager.NetworkCallback() {
                // onAvailable → onCapabilitiesChanged: only the latter reliably has the transport bits.
                @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                    try {
                        if (caps == null) return;
                        boolean isDefault;
                        try {
                            // API 31+ has DEFAULT_NETWORK, but we can also verify via connectivityMgr.getActiveNetwork below.
                            isDefault = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                                     && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                        } catch (Throwable ignore) { isDefault = true; }
                        if (!isDefault) return;
                        int trans = 0;
                        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) trans = 1;
                        else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) trans = 2;
                        refreshWifiLockByDefaultNetwork(trans, "onCapabilitiesChanged");
                    } catch (Throwable t) { Log.w(TAG, "networkCallback.onCapabilitiesChanged FAIL: " + t); }
                }

                @Override public void onLost(Network network) {
                    try {
                        // Default network might drop briefly during handoff; mark unknown then force a synchronous
                        // refresh from ConnectivityManager so we don't release the WifiLock spuriously for 500ms.
                        lastActiveTransport = -1;
                        refreshWifiLockByDefaultNetwork("onLost→forceSync");
                    } catch (Throwable t) { Log.w(TAG, "networkCallback.onLost FAIL: " + t); }
                }
            };
        } catch (Throwable t) {
            Log.e(TAG, "buildNetworkCallback FAIL: " + t);
            networkCallback = null;
        }
    }

    // V87d: Register the callback + force an immediate synchronous refresh.
    // Idempotent: already registered? skip register, but still refresh.
    // V87e: MUST pass Handler(Looper.getMainLooper()) as 3rd argument. The 2-arg overload internally creates a
    // new Handler() using the *caller* thread's Looper, but @JavascriptInterface pool threads have NO Looper.
    // Result before V87e: "Can't create handler inside thread that has not called Looper.prepare()" thrown
    // (then swallowed by catch) → networkCallback never registered → cellular never releases WifiLock.
    private void registerNetworkCallbackIfNeeded() {
        if (connectivityMgr == null || networkCallback == null) return;
        try {
            if (!networkCallbackRegistered) {
                NetworkRequest req = new NetworkRequest.Builder()
                        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        .build();
                try {
                    // V87e: 3-arg (request, callback, handler). Uses handler's Looper = main looper.
                    // API 21+: registerNetworkCallback(NetworkRequest, NetworkCallback, Handler) exists since Lollipop.
                    connectivityMgr.registerNetworkCallback(req, networkCallback, MAIN_HANDLER);
                } catch (Throwable t1) {
                    // SecurityException on rare devices (battery saver restricting APIs) → fall back to default request.
                    Log.w(TAG, "registerNetworkCallback(req,cb,MAIN_HANDLER) FAIL, fallback to registerDefaultNetworkCallback(cb,MAIN_HANDLER): " + t1);
                    try {
                        // V87e: also pass MAIN_HANDLER explicitly (26+ overload). For older devices we fall
                        // back to 2-arg but are ALREADY on MAIN_HANDLER thread here (runs inside our dispatcher
                        // because apiPlayFromBinder posts everything to MAIN_HANDLER), so 2-arg is safe even on old.
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            connectivityMgr.registerDefaultNetworkCallback(networkCallback, MAIN_HANDLER);
                        } else {
                            // Pre-26: no Handler overload. But we always arrive here on MAIN_HANDLER thread
                            // (because all public forwarders post → MAIN_HANDLER), so caller-thread = main
                            // has Looper. Safe.
                            connectivityMgr.registerDefaultNetworkCallback(networkCallback);
                        }
                    }
                    catch (Throwable t2) { Log.e(TAG, "registerDefaultNetworkCallback also FAIL: " + t2); return; }
                }
                networkCallbackRegistered = true;
                Log.e(TAG, "registerNetworkCallbackIfNeeded: NetworkCallback REGISTERED OK (MAIN_HANDLER enforced)");
            }
        } catch (Throwable t) { Log.e(TAG, "registerNetworkCallbackIfNeeded TOP FAIL: " + t); }
        // Synchronous refresh of the current state immediately after (re)registering, so WifiLock state is correct
        // within the same handlePlay() frame, not waiting for the first async callback.
        refreshWifiLockByDefaultNetwork("registerIfNeeded→sync");
    }

    // V87d: Unregister the callback (handlePause/handleStop/onDestroy) - prevent Service leak.
    private void unregisterNetworkCallbackIfNeeded() {
        if (connectivityMgr == null || networkCallback == null || !networkCallbackRegistered) return;
        try {
            connectivityMgr.unregisterNetworkCallback(networkCallback);
            networkCallbackRegistered = false;
            lastActiveTransport = -1;
            Log.e(TAG, "unregisterNetworkCallbackIfNeeded: NetworkCallback UNREGISTERED OK");
        } catch (Throwable t) { Log.w(TAG, "unregisterNetworkCallbackIfNeeded FAIL (harmless, double-unreg?): " + t); }
    }

    // V87d: Probe default network synchronously, compute transport, then hand off to core idempotent setter.
    private void refreshWifiLockByDefaultNetwork(String reason) {
        int trans = 0;
        try {
            if (connectivityMgr != null) {
                Network an = connectivityMgr.getActiveNetwork();
                if (an != null) {
                    NetworkCapabilities caps = connectivityMgr.getNetworkCapabilities(an);
                    if (caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                        if      (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI))     trans = 1;
                        else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) trans = 2;
                    }
                }
            }
        } catch (Throwable t) { Log.w(TAG, "refreshWifiLockByDefaultNetwork(sync probe) FAIL: " + t); trans = -2; }
        refreshWifiLockByDefaultNetwork(trans, reason);
    }

    // V87d: Core idempotent setter. PARTIAL_WAKE_LOCK is NOT touched here (it's handled by acquireLocks/releaseLocks).
    // ONLY WifiLock is toggled dynamically:
    //   transport = WIFI    (1) → wifiLock acquire (guarantee no Light-Doze Wi-Fi starvation during play)
    //   transport = CELLULAR(2) → wifiLock release (Wi-Fi chip is idle anyway; hold no useless lock)
    //   transport = NONE/UNKNOWN(0,-1,-2) → no change (don't thrash during brief handoffs between Wi-Fi↔towers)
    private void refreshWifiLockByDefaultNetwork(int transport, String reason) {
        try {
            if (wifiLock == null) return;
            if (transport <= 0) {
                Log.d(TAG, "refreshWifiLock transport=" + transport + " (" + reason + ") → NO-CHANGE (handoff)");
                return;
            }
            if (transport == lastActiveTransport) {
                // Idempotent: same as last → skip any jni call, just log once-then-suppress via debug level only
                return;
            }
            boolean held = wifiLock.isHeld();
            if (transport == 1) {
                // WIFI → need WifiLock
                if (!held) {
                    try { wifiLock.acquire(); Log.e(TAG, "refreshWifiLock(WIFI, reason=" + reason + "): WifiLock ACQUIRED"); }
                    catch (Throwable t) { Log.e(TAG, "refreshWifiLock(WIFI) acquire FAIL: " + t); return; }
                } else {
                    Log.d(TAG, "refreshWifiLock(WIFI, reason=" + reason + "): already held → noop");
                }
                lastActiveTransport = 1;
            } else if (transport == 2) {
                // CELLULAR → release WifiLock (no Wi-Fi activity possible, pointless to hold)
                if (held) {
                    try { wifiLock.release(); Log.e(TAG, "refreshWifiLock(CELLULAR, reason=" + reason + "): WifiLock RELEASED (saves ~3-8mA)"); }
                    catch (Throwable t) { Log.e(TAG, "refreshWifiLock(CELLULAR) release FAIL: " + t); return; }
                } else {
                    Log.d(TAG, "refreshWifiLock(CELLULAR, reason=" + reason + "): not held → noop");
                }
                lastActiveTransport = 2;
            }
        } catch (Throwable t) { Log.w(TAG, "refreshWifiLockByDefaultNetwork(int,reason) TOP FAIL: " + t); }
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

    // V87-FIX: public forwarders called directly by MainActivity via Binder (LocalBinder).
    // Service 是通过 bindService 启动的，不走 onStartCommand，所以任何 startService() 的 Intent 都不生效
    // （startService 返回但 onStartCommand 永远 0 次调用），直接通过 Binder 拿到 Service 引用调这些方法，
    // 绕过 lifecycle 限制 → startForeground + acquireLocks 100% 立即执行。
    //
    // V87e CRITICAL: 所有这四个 public forwarders 绝对不能在调用线程执行。
    //  调用方是:
    //   (1) @JavascriptInterface 的 JavaBridge binder 线程池线程（NO LOOPER，非主线程）
    //   (2) MainActivity 自身也可能在后台 Binder 线程池调用 sendCommandToService。
    //  若在非主线程执行会导致 ColorOS/OPPO 3 类确定 crash/性能 bug：
    //    BugA: startForeground + buildNotification 访问 NotificationManager#enqueueNotificationWithTag
    //          + MediaStyle#buildMediaSession，ColorOS 对该路径会做"must be called from UI thread"断言
    //          → FATAL EXCEPTION: Binder:xxx_xx，直接闪退（用户"快速切台 2~3 次 crash"根因）
    //    BugB: registerNetworkCallback(req, cb) 2 参数重载内部 new Handler() → 需要调用线程有 Looper
    //          → "Can't create handler inside thread that has not called Looper.prepare()"，被 try/catch 吞
    //          → networkCallbackRegistered 永远 false，切蜂窝 NEVER release WifiLock
    //          → 每次切台打印 2 次 Throwable stacktrace → CPU 80ms burn → "首次打开故城台很久才播 + toast"
    //    BugC: unregister → register 并发 thrashing（切台 0.1s/次时）NetworkRequest#builder 内部 mReaper
    //          binder race → 某些 Android 12/13 版本 IllegalState / SecurityException。
    //  统一解决：
    //    1) 所有入口立刻 post 到 MAIN_HANDLER（Looper.getMainLooper）串行化；
    //    2) 200ms debounce：200ms 内连续 PLAY/META/PAUSE 请求合并为最后一个；
    //    3) register/unregister 都保证在 MAIN_HANDLER 执行（有 Looper）；
    //    4) registerNetworkCallback 一律用 3 参数带 Handler，不依赖调用线程的隐式 Looper。
    public void apiPlayFromBinder(final String name, final String subtitle, final boolean notifyUi) {
        // V87f: FAST NO-OP SKIP — zero-allocation exit if incoming matches last dispatched EXACTLY.
        // Since each @JavascriptInterface call burns ~3-8 JNI transitions + main-thread
        // removeCallbacks+post, this eliminates CPU churn when JS audio events fire duplicates
        // (onplaying+onplay+canplaythrough within 1 frame all reportPlaying with identical data).
        final String nm = (name != null) ? name : "";
        final String sb = (subtitle != null) ? subtitle : "";
        if (nm.equals(lastDispatchedName) && sb.equals(lastDispatchedSubtitle)
                && lastDispatchedPlaying && isPlaying) {
            Log.d(TAG, "apiPlayFromBinder: FAST-SKIP (same as dispatched, already playing). name=[" + nm + "]");
            return;
        }
        // V87e: NEVER run on caller thread → always post to MAIN_HANDLER.
        final long now = System.currentTimeMillis();
        if (pendingActionRunnable != null) {
            MAIN_HANDLER.removeCallbacks(pendingActionRunnable);
            pendingActionRunnable = null;
        }
        pendingActionTs = now;
        pendingActionRunnable = new Runnable() {
            @Override public void run() {
                pendingActionRunnable = null;
                // Update stable field copies under MAIN_HANDLER lock.
                if (name != null && name.length() > 0) channelName = name;
                if (subtitle != null && subtitle.length() > 0) channelSubtitle = subtitle;
                lastDispatchedName = channelName;
                lastDispatchedSubtitle = channelSubtitle;
                lastDispatchedPlaying = true;
                Log.e(TAG, "apiPlayFromBinder → MAIN_HANDLER dispatcher (debounced). name=[" + channelName + "] sub=[" + channelSubtitle + "] notifyUi=" + notifyUi);
                updateMetadata();
                handlePlay(notifyUi);
            }
        };
        // Wait at most PENDING_ACTION_DEBOUNCE_MS from the FIRST action in a burst (not "sliding window")
        // so very rapid taps still dispatch eventually, not forever.
        MAIN_HANDLER.postDelayed(pendingActionRunnable, PENDING_ACTION_DEBOUNCE_MS);
        Log.d(TAG, "apiPlayFromBinder(callerThread=" + Thread.currentThread().getName() + "): enqueued action (debounce " + PENDING_ACTION_DEBOUNCE_MS + "ms)");
    }
    public void apiPauseFromBinder(final String name, final String subtitle, final boolean notifyUi) {
        final String nm = (name != null) ? name : "";
        final String sb = (subtitle != null) ? subtitle : "";
        // V87f: fast skip — paused state already matches last dispatch
        if (nm.equals(lastDispatchedName) && sb.equals(lastDispatchedSubtitle)
                && !lastDispatchedPlaying && !isPlaying) {
            Log.d(TAG, "apiPauseFromBinder: FAST-SKIP (same as dispatched, already paused). name=[" + nm + "]");
            return;
        }
        final long now = System.currentTimeMillis();
        if (pendingActionRunnable != null) {
            MAIN_HANDLER.removeCallbacks(pendingActionRunnable);
            pendingActionRunnable = null;
        }
        pendingActionTs = now;
        pendingActionRunnable = new Runnable() {
            @Override public void run() {
                pendingActionRunnable = null;
                if (name != null && name.length() > 0) channelName = name;
                if (subtitle != null && subtitle.length() > 0) channelSubtitle = subtitle;
                // Playing transitions to false
                lastDispatchedName = channelName;
                lastDispatchedSubtitle = channelSubtitle;
                lastDispatchedPlaying = false;
                Log.e(TAG, "apiPauseFromBinder → MAIN_HANDLER dispatcher (debounced). name=[" + channelName + "] notifyUi=" + notifyUi);
                updateMetadata();
                handlePause(notifyUi);
            }
        };
        MAIN_HANDLER.postDelayed(pendingActionRunnable, PENDING_ACTION_DEBOUNCE_MS);
        Log.d(TAG, "apiPauseFromBinder(callerThread=" + Thread.currentThread().getName() + "): enqueued");
    }
    public void apiMetaFromBinder(final String name, final String subtitle, final boolean playing) {
        // V87f: FAST SKIP (before ANY object allocation / removeCallbacks) if all 3 match.
        // This is THE hottest path: reportNativeState(force=false) audio event callbacks fire
        // 4-6 times per playChannel() frame (onloadstart → onprogress → oncanplay → onplaying)
        // and without this early-exit we'd rebuild the notification + media session each time.
        final String nm = (name != null) ? name : "";
        final String sb = (subtitle != null) ? subtitle : "";
        if (nm.equals(lastDispatchedName) && sb.equals(lastDispatchedSubtitle)
                && (playing == lastDispatchedPlaying)) {
            Log.d(TAG, "apiMetaFromBinder: FAST-SKIP (all 3 match last dispatched). name=[" + nm + "] playing=" + playing);
            return;
        }
        // apiMetaFromBinder is called more often than any other binder action (JS may call reportMeta 3-5 times
        // during playChannel startup). Debouncing here is THE critical optimization to eliminate JNI thrash.
        if (pendingActionRunnable != null) {
            MAIN_HANDLER.removeCallbacks(pendingActionRunnable);
            pendingActionRunnable = null;
        }
        pendingActionTs = System.currentTimeMillis();
        pendingActionRunnable = new Runnable() {
            @Override public void run() {
                pendingActionRunnable = null;
                // Fast no-op: name/subtitle/playing all match last dispatched → SKIP JNI calls entirely.
                boolean sameName     = (name == null) ? (lastDispatchedName.length() == 0) : name.equals(lastDispatchedName);
                boolean sameSub      = (subtitle == null) ? (lastDispatchedSubtitle.length() == 0) : subtitle.equals(lastDispatchedSubtitle);
                boolean samePlaying  = (playing == lastDispatchedPlaying);
                if (sameName && sameSub && samePlaying) {
                    Log.d(TAG, "apiMetaFromBinder dispatcher: SAME as last (" + name + "," + playing + ") → SKIP (saves 3-4 JNI calls + notification rebuild)");
                    return;
                }
                if (name != null && name.length() > 0) channelName = name;
                if (subtitle != null && subtitle.length() > 0) channelSubtitle = subtitle;
                lastDispatchedName = channelName;
                lastDispatchedSubtitle = channelSubtitle;
                lastDispatchedPlaying = playing;
                Log.e(TAG, "apiMetaFromBinder → MAIN_HANDLER dispatcher. name=[" + channelName + "] sub=[" + channelSubtitle + "] playing=" + playing);
                updateMetadata();
                if (playing && !isPlaying) handlePlay(false);
                else if (!playing && isPlaying) handlePause(false);
                else updateNotification();
            }
        };
        MAIN_HANDLER.postDelayed(pendingActionRunnable, PENDING_ACTION_DEBOUNCE_MS);
        Log.d(TAG, "apiMetaFromBinder(callerThread=" + Thread.currentThread().getName() + "): enqueued");
    }
    public void apiStopFromBinder(final boolean notifyUi) {
        // V87f: fast skip — already stopped and no pending action
        if (!lastDispatchedPlaying && !isPlaying && pendingActionRunnable == null) {
            Log.d(TAG, "apiStopFromBinder: FAST-SKIP (already stopped, no pending)");
            return;
        }
        // STOP is high-priority (user explicitly tapped stop). Do NOT debounce STOP — dispatch ASAP but
        // still on MAIN_HANDLER to serialize with any in-flight play/pause that has just been posted.
        if (pendingActionRunnable != null) {
            MAIN_HANDLER.removeCallbacks(pendingActionRunnable);
            pendingActionRunnable = null;
        }
        MAIN_HANDLER.post(new Runnable() {
            @Override public void run() {
                lastDispatchedPlaying = false;
                pendingActionRunnable = null;
                Log.e(TAG, "apiStopFromBinder → MAIN_HANDLER dispatcher (STOP no-debounce). notifyUi=" + notifyUi);
                handleStop(notifyUi);
            }
        });
        Log.d(TAG, "apiStopFromBinder(callerThread=" + Thread.currentThread().getName() + "): posted immediately (no debounce)");
    }

    private void acquireLocks() {
        // V87d: Only PARTIAL_WAKE_LOCK is blindly acquired here (it is NEVER release mid-play).
        // WifiLock is now managed dynamically by registerNetworkCallbackIfNeeded → refreshWifiLockByDefaultNetwork,
        // which will either acquire it (on Wi-Fi) or leave it released (on cellular) based on the actual default network.
        try { if (wakeLock != null && !wakeLock.isHeld()) { wakeLock.acquire(); Log.e(TAG, "acquireLocks: WakeLock(PARTIAL_WAKE_LOCK) ACQUIRED"); } } catch (Throwable t) { Log.e(TAG, "acquireLocks: wakeLock FAIL " + t); }
        // Keep a safety fallback for legacy/unusual paths: if ConnectivityManager is unavailable, acquire WifiLock
        // always (the pre-V87d behavior, no worse than before).
        try {
            if (connectivityMgr == null || networkCallback == null) {
                if (wifiLock != null && !wifiLock.isHeld()) { wifiLock.acquire(); Log.e(TAG, "acquireLocks: [fallback-no-callback] WifiLock ACQUIRED"); }
            }
        } catch (Throwable t) { Log.e(TAG, "acquireLocks: fallback wifiLock FAIL " + t); }
    }

    private void releaseLocks() {
        // V87d: Release both. PARTIAL_WAKE_LOCK always released here (pause/stop/destroy).
        // WifiLock also released here (even if dynamically released earlier, double-release is harmless because
        // setReferenceCounted(false) + we guard with isHeld).
        try { if (wakeLock != null && wakeLock.isHeld()) { wakeLock.release(); Log.e(TAG, "releaseLocks: WakeLock RELEASED"); } } catch (Throwable t) { Log.e(TAG, "releaseLocks: wakeLock FAIL " + t); }
        try { if (wifiLock != null && wifiLock.isHeld()) { wifiLock.release(); Log.e(TAG, "releaseLocks: WifiLock RELEASED"); } } catch (Throwable t) { Log.e(TAG, "releaseLocks: wifiLock FAIL " + t); }
        // Reset the cached transport so a fresh sync probe runs next time we re-enter handlePlay.
        lastActiveTransport = -1;
    }

    private void handlePlay(boolean notifyUi) {
        Log.e(TAG, "handlePlay(notifyUi=" + notifyUi + ") ENTER channelName=[" + channelName + "]");
        if (!requestAudioFocus()) {
            Log.w(TAG, "handlePlay: AudioFocus request FAIL");
        }
        acquireLocks();
        // V87d: Register NetworkCallback + synchronous refresh (idempotent) so WifiLock state matches current
        // active network immediately (Wi-Fi → held; cellular → released) - even if we started playing on cellular.
        registerNetworkCallbackIfNeeded();
        isPlaying = true;
        stateBuilder.setState(PlaybackStateCompat.STATE_PLAYING, 0, 1.0f);
        try { mediaSession.setPlaybackState(stateBuilder.build()); } catch (Throwable ignore) {}
        try { mediaSession.setActive(true); } catch (Throwable ignore) {}
        try {
            startForeground(NOTIFICATION_ID, buildNotification());
            Log.e(TAG, "handlePlay: startForeground() OK (NOTIFICATION_ID=" + NOTIFICATION_ID + ") → startForegroundCount will increment");
        } catch (Throwable t) {
            Log.e(TAG, "handlePlay: startForeground FAIL " + t, t);
        }
        updateNotification();
        if (notifyUi) sendBroadcastToUI(ACTION_PLAY);
        else Log.d(TAG, "handlePlay: internal state update only (skip broadcast to UI)");
    }

    private void handlePause(boolean notifyUi) {
        Log.e(TAG, "handlePause(notifyUi=" + notifyUi + ") ENTER channelName=[" + channelName + "]");
        isPlaying = false;
        stateBuilder.setState(PlaybackStateCompat.STATE_PAUSED, 0, 1.0f);
        try { mediaSession.setPlaybackState(stateBuilder.build()); } catch (Throwable ignore) {}
        try { mediaSession.setActive(true); } catch (Throwable ignore) {}
        try { stopForeground(STOP_FOREGROUND_DETACH); } catch (Throwable ignore) {
            try { stopForeground(false); } catch (Throwable ig) {}
        }
        updateNotification();
        // V87d: pause → unregister network callback (no need to track handoffs while not listening)
        unregisterNetworkCallbackIfNeeded();
        releaseLocks();
        abandonAudioFocus();
        if (notifyUi) sendBroadcastToUI(ACTION_PAUSE);
        else Log.d(TAG, "handlePause: internal state update only (skip broadcast to UI)");
    }

    private void handleStop(boolean notifyUi) {
        isPlaying = false;
        stateBuilder.setState(PlaybackStateCompat.STATE_STOPPED, 0, 1.0f);
        try { mediaSession.setPlaybackState(stateBuilder.build()); } catch (Throwable ignore) {}
        try { mediaSession.setActive(false); } catch (Throwable ignore) {}
        try { stopForeground(STOP_FOREGROUND_REMOVE); } catch (Throwable ignore) {
            try { stopForeground(true); } catch (Throwable ig) {}
        }
        try { notificationManager.cancel(NOTIFICATION_ID); } catch (Throwable ignore) {}
        // V87d: stop → unregister network callback (no state to track)
        unregisterNetworkCallbackIfNeeded();
        releaseLocks();
        abandonAudioFocus();
        if (notifyUi) sendBroadcastToUI(ACTION_STOP);
        else Log.d(TAG, "handleStop: internal state update only (skip broadcast to UI)");
        stopSelf();
    }

    private void updateMetadata() {
        MediaMetadataCompat.Builder mb = new MediaMetadataCompat.Builder();
        mb.putString(MediaMetadataCompat.METADATA_KEY_TITLE, channelName.isEmpty() ? "复古网络收音机" : channelName);
        mb.putString(MediaMetadataCompat.METADATA_KEY_ARTIST, channelSubtitle.isEmpty() ? "FM RetroRadio" : channelSubtitle);
        mb.putString(MediaMetadataCompat.METADATA_KEY_ALBUM, "FM RetroRadio");
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
                // Permanent loss (user started another long-playing app).
                // Still avoid broadcasting PAUSE: Chromium will pause audio
                // internally via AudioTrack focus loss. Only update Service
                // internal state + Notification UI.
                isPlaying = false;
                releaseLocks();
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

    public static final String UI_ACTION_UPDATE = "com.retro.radio.UI";
    public static final String EXTRA_UI_EVENT = "event";

    // (private 版已上移到 isPlaying() 旁改为 public，这里保留兼容方法防止重复定义)
    private void sendBroadcastToUIPrivate(String event) {
        sendBroadcastToUI(event);
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
    public void onDestroy() {
        Log.d(TAG, "onDestroy");
        try { unregisterReceiver(uiReceiver); } catch (Throwable ignore) {}
        try { if (mediaSession != null) { mediaSession.setActive(false); mediaSession.release(); } } catch (Throwable ignore) {}
        // V87d: destroy → unregister callback FIRST (otherwise service leak) before releasing locks.
        unregisterNetworkCallbackIfNeeded();
        releaseLocks();
        abandonAudioFocus();
        try { notificationManager.cancel(NOTIFICATION_ID); } catch (Throwable ignore) {}
        super.onDestroy();
    }
}
