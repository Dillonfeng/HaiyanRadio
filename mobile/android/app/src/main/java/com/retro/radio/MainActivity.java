package com.retro.radio;

import android.Manifest;
import android.app.ActivityManager;
import android.content.BroadcastReceiver;
import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.bluetooth.BluetoothDevice;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.ConsoleMessage;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import android.util.Log;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

import java.io.OutputStream;
import java.io.InputStream;

public class MainActivity extends BridgeActivity {

    // V156: SAF (Storage Access Framework) ActivityResultLauncher
    //   - 导出/备份: ACTION_CREATE_DOCUMENT 让用户选择保存路径和文件名
    //   - 导入/恢复: ACTION_OPEN_DOCUMENT 让用户选择文件（替代 <input type=file>，Android WebView 有时不响应）
    private ActivityResultLauncher<Intent> safCreateDocumentLauncher;
    private ActivityResultLauncher<Intent> safOpenDocumentLauncher;
    // SAF 操作的上下文信息（通过 localStorage 中转给 JS）
    private volatile String safPendingType = "";   // "export" | "backup" | "import" | "restore"
    private volatile String safPendingSourceKey = "";  // JS 存入 localStorage 的 key: __pending_export_channels__ / __pending_backup__
    private volatile String safPendingResultKey = "";  // Java 回写给 JS 的 key: __saf_result_export__ 等
    private volatile WebView safWvRef = null;

    private static final String TAG = "RetroRadioMain";

    public static final String DEBUG_ACTION_EVAL_JS = "com.retro.radio.DEBUG_EVAL_JS";
    public static final String DEBUG_EXTRA_JS = "js";

    private RadioPlaybackService playbackService;
    private boolean serviceBound = false;
    private ServiceReceiver serviceReceiver;
    private DebugEvalReceiver debugEvalReceiver;
    private volatile boolean playingFlag = false;
    private volatile String currentName = "";
    private volatile String currentSubtitle = "";
    // V100 NATIVE-EXOPLAYER: NativeAudioPlayer instance, added as JS interface "NativeAudio"
    // so JS can bypass HTML5 <audio> (which ColorOS kills at T+180s ActivityRecord freezer)
    private NativeAudioPlayer nativeAudioPlayer = null;
    // V170: 当前存活Activity的WebView，供进程级单例播放器派发事件时定位目标页面
    private static volatile android.webkit.WebView sActiveWv = null;
    // WebView hooks are applied ONCE, the first time the bridge/wv becomes
    // non-null. Previously we installed WebChromeClient/WebViewClient from 3
    // different places (fixWebViewSettings + repeatedlyEnsure loop idx2+
    // optimizeWebViewPower) which caused the last writer to win and earlier
    // hooks (console bridge, NativeRadio interface) to be silently discarded
    // → 0 RetroRadio lines in logcat, which made all prior "analysis" blind
    // guesswork. Now we apply hooks atomically and log if they fail.
    private volatile boolean webViewHooksInstalled = false;
    private final Object hookLock = new Object();
    // 网络切换自动重连：监听网络恢复事件，通知 JS 重新加载播放
    private ConnectivityManager.NetworkCallback networkReconnectCallback = null;
    private volatile boolean lastNetworkAvailable = true;
    // V180: 蓝牙音频断开/重连监听已整体迁移到 RadioPlaybackService（FGS，后台可靠）。
    //   Activity 只通过 ServiceReceiver 接收 BT_DISC/BT_RECONN 广播做 UI 同步，
    //   并在 onResume 时向 Service 查询最新蓝牙断开态（覆盖后台期间发生的断开/恢复）。
    // V80: androidScheme=http in capacitor.config.json means page origin is
    // http://localhost, the SAME scheme as plain-HTTP radio streams. Mixed
    // Content checking (Chromium blocks HTTP subresources on HTTPS pages)
    // simply does not apply, so we don't need the local loopback IcyCleanProxy
    // at all. Keep field / wrapProxyUrl method for backward compatibility but
    // do NOT start the proxy server; wrapProxyUrl becomes identity. This
    // matches Electron (file:// origin + webSecurity:false → direct-URL).
    @SuppressWarnings("FieldCanBeLocal")
    private final IcyCleanProxy icyProxyUnusedV80 = null;
    // NativeBridge instance is created once during hook installation, so we
    // can expose wrapProxyUrl / playUrl etc. without re-creating the bridge.
    private NativeBridge nativeBridgeInstance;

    // V135: 定位权限请求回调 storage — 存 onGeolocationPermissionsShowPrompt 里的 callback，等权限结果再执行
    private android.webkit.GeolocationPermissions.Callback pendingGeoCallback = null;
    private String pendingGeoOrigin = null;
    private static final int REQ_LOCATION = 22331;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder service) {
            RadioPlaybackService.LocalBinder binder = (RadioPlaybackService.LocalBinder) service;
            playbackService = binder.getService();
            serviceBound = true;
            Log.i(TAG, "RadioPlaybackService connected");
        }
        @Override public void onServiceDisconnected(ComponentName name) {
            serviceBound = false;
            playbackService = null;
            Log.w(TAG, "RadioPlaybackService disconnected");
        }
    };

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.i(TAG, "onCreate BEGIN app=v1.3.190 / buildV190 / dual-phase silence delay / no rebuild on restore / androidScheme=http / badge=about / no-play-toast");

        // V156: SAF - 注册 ActivityResultLauncher（必须在 onCreate 完成 STARTED 前注册）
        //   1) CreateDocument: 导出 / 备份 → 让用户选保存路径+文件名
        safCreateDocumentLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    Intent data = result.getData();
                    int rc = result.getResultCode();
                    String type = safPendingType;
                    String srcKey = safPendingSourceKey;
                    String resKey = safPendingResultKey;
                    WebView wv = safWvRef;
                    safPendingType = ""; safPendingSourceKey = ""; safPendingResultKey = ""; safWvRef = null;
                    if (rc != android.app.Activity.RESULT_OK || data == null || data.getData() == null) {
                        Log.w(TAG, "V156-SAF CreateDocument canceled (rc=" + rc + ")");
                        safWriteResult(wv, resKey, "{\"ok\":false,\"err\":\"用户取消\"}");
                        return;
                    }
                    final Uri targetUri = data.getData();
                    final String fSrcKey = srcKey;
                    final String fResKey = resKey;
                    final WebView fWv = wv;
                    new Thread(() -> {
                        try {
                            // Step1: 从 localStorage 读取待导出内容
                            String content = safReadLocalStorageAndRemove(fWv, fSrcKey);
                            if (content == null || content.isEmpty()) {
                                Log.e(TAG, "V156-SAF CreateDocument: localStorage " + fSrcKey + " empty");
                                safWriteResult(fWv, fResKey, "{\"ok\":false,\"err\":\"待导出数据为空\"}");
                                return;
                            }
                            // Step2: 写入用户选定的 URI
                            try (OutputStream os = getContentResolver().openOutputStream(targetUri)) {
                                if (os == null) throw new Exception("openOutputStream null");
                                os.write(content.getBytes("UTF-8"));
                                os.flush();
                            }
                            Log.i(TAG, "V156-SAF CreateDocument OK, uri=" + targetUri + ", size=" + content.length());
                            safWriteResult(fWv, fResKey, "{\"ok\":true,\"path\":\"SAF:" + targetUri.toString().replace("\"","\\\"") + "\",\"size\":" + content.length() + "}");
                        } catch (Throwable t) {
                            Log.e(TAG, "V156-SAF CreateDocument FAIL: " + t, t);
                            String emsg = t.getMessage() != null ? t.getMessage().replace("\"","\\\"") : String.valueOf(t);
                            safWriteResult(fWv, fResKey, "{\"ok\":false,\"err\":\"" + emsg + "\"}");
                        }
                    }).start();
                });
        //   2) OpenDocument: 导入 / 恢复 → 让用户选文件
        safOpenDocumentLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    Intent data = result.getData();
                    int rc = result.getResultCode();
                    String type = safPendingType;
                    String resKey = safPendingResultKey;
                    WebView wv = safWvRef;
                    safPendingType = ""; safPendingSourceKey = ""; safPendingResultKey = ""; safWvRef = null;
                    if (rc != android.app.Activity.RESULT_OK || data == null || data.getData() == null) {
                        Log.w(TAG, "V156-SAF OpenDocument canceled (rc=" + rc + ")");
                        safWriteResult(wv, resKey, "{\"ok\":false,\"err\":\"用户取消\"}");
                        return;
                    }
                    final Uri fileUri = data.getData();
                    final String fResKey = resKey;
                    final WebView fWv = wv;
                    new Thread(() -> {
                        try {
                            // 从 URI 读取文件内容
                            StringBuilder sb = new StringBuilder();
                            try (InputStream is = getContentResolver().openInputStream(fileUri)) {
                                if (is == null) throw new Exception("openInputStream null");
                                byte[] buf = new byte[16384];
                                int n;
                                while ((n = is.read(buf)) > 0) sb.append(new String(buf, 0, n, "UTF-8"));
                            }
                            String content = sb.toString();
                            String dispName = "";
                            try {
                                android.database.Cursor c = getContentResolver().query(fileUri,
                                        new String[]{android.provider.OpenableColumns.DISPLAY_NAME},
                                        null, null, null);
                                if (c != null) { try { if (c.moveToFirst()) dispName = c.getString(0); } finally { c.close(); } }
                            } catch (Throwable ignore) {}
                            Log.i(TAG, "V156-SAF OpenDocument OK: " + dispName + " size=" + content.length());
                            JSONObject jo = new JSONObject();
                            jo.put("ok", true);
                            jo.put("content", content);
                            jo.put("filename", dispName);
                            jo.put("size", content.length());
                            safWriteResult(fWv, fResKey, jo.toString());
                        } catch (Throwable t) {
                            Log.e(TAG, "V156-SAF OpenDocument FAIL: " + t, t);
                            String emsg = t.getMessage() != null ? t.getMessage().replace("\"","\\\"") : String.valueOf(t);
                            safWriteResult(fWv, fResKey, "{\"ok\":false,\"err\":\"" + emsg + "\"}");
                        }
                    }).start();
                });

        registerServiceReceiver();
        registerDebugEvalReceiver();
        bindService();
        // V80: install hooks from the first non-null WebView moment, then never
        // touch them again. Poll every 60ms for up to ~2.4s (enough for even
        // the slowest ColorOS bridge init).
        final Handler h = new Handler(Looper.getMainLooper());
        for (int i = 0; i < 40; i++) {
            final int idx = i;
            // V112 TIMING FIX: poll间隔从60ms→1ms起步！最快0ms就执行installWebViewHooksOnce
            // （i=0时是0ms立即执行，i=1时是1ms...）让addJavascriptInterface(NativeAudio/NativeRadio)
            // 尽可能早注入完成！避免用户点台时Native接口还没注入=hasNativeObj=false=用WebEngine锁屏无声
            h.postDelayed(new Runnable() {
                @Override public void run() {
                    try {
                        Bridge b = getBridge();
                        WebView wv = (b != null) ? b.getWebView() : null;
                        if (wv == null) {
                            Log.d(TAG, "hook poll #" + idx + ": bridge/wv still NULL, will retry");
                            return;
                        }
                        installWebViewHooksOnce(wv);
                    } catch (Throwable t) {
                        Log.wtf(TAG, "hook poll #" + idx + " FATAL (please report):", t);
                    }
                }
            }, i == 0 ? 0L : Math.min((long) i * 2L, 120L));
        }
        // OPPO ColorOS AppFrozen 防护：启动时主动请求电池优化白名单（每3次启动请求一次，避免频繁打扰）
        try { maybeRequestBatteryOptimization(); } catch (Throwable t) { Log.w(TAG, "maybeRequestBatteryOptimization: " + t); }
        // 网络切换自动重连：注册网络监听，网络恢复时通知 JS 重新加载播放
        try { registerNetworkReconnectMonitor(); } catch (Throwable t) { Log.w(TAG, "registerNetworkReconnectMonitor: " + t); }
        // V180: 蓝牙音频监听已迁移到 RadioPlaybackService（FGS 后台可靠），Activity 不再注册
        Log.i(TAG, "onCreate END");
    }

    // =========================================================
    // 稳定性增强：电池优化白名单（防 OPPO ColorOS AppFrozen 冻结）
    // =========================================================
    private void maybeRequestBatteryOptimization() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null) return;
            if (pm.isIgnoringBatteryOptimizations(getPackageName())) {
                Log.d(TAG, "maybeRequestBatteryOptimization: already whitelisted");
                return;
            }
            SharedPreferences sp = getSharedPreferences("retro_stability", MODE_PRIVATE);
            int launches = sp.getInt("launch_count", 0) + 1;
            sp.edit().putInt("launch_count", launches).apply();
            // 每3次启动请求一次，避免频繁打扰用户
            if (launches % 3 != 0) {
                Log.d(TAG, "maybeRequestBatteryOptimization: skip this launch (" + launches + ")");
                return;
            }
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
            Log.i(TAG, "maybeRequestBatteryOptimization: prompted user (launch=" + launches + ")");
        } catch (Throwable t) { Log.w(TAG, "maybeRequestBatteryOptimization FAIL: " + t); }
    }

    // =========================================================
    // 稳定性增强：网络切换自动重连
    // 无线↔5G 切换时 hls.js/Icecast 可能断流，Java 层监听网络恢复并通知 JS 重连
    // =========================================================
    private void registerNetworkReconnectMonitor() {
        if (networkReconnectCallback != null) return; // 已注册
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) { Log.w(TAG, "registerNetworkReconnectMonitor: CM null"); return; }
            NetworkRequest req = new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .build();
            networkReconnectCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    // V172 FIX(网络切换多次卡顿根因): onAvailable 只代表链路连上（数据流量此时往往
                    //   还未VALIDATED），此时通知JS会触发playChannel打到不可用网络上→超时报错→
                    //   V164退避→下一路通知又重载→反复卡顿。等onCapabilitiesChanged验证后再通知。
                    Log.i(TAG, "[NET-RECONNECT] onAvailable: network recovered (wait for validation)");
                }
                @Override
                public void onLost(Network network) {
                    Log.w(TAG, "[NET-RECONNECT] onLost: network lost");
                    lastNetworkAvailable = false;
                }
                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
                    boolean hasNet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                            && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
                    if (hasNet && !lastNetworkAvailable) {
                        Log.i(TAG, "[NET-RECONNECT] onCapabilitiesChanged: validated internet restored");
                        lastNetworkAvailable = true;
                        notifyJsNetworkReconnect();
                    } else if (!hasNet) {
                        lastNetworkAvailable = false;
                    }
                }
            };
            cm.registerNetworkCallback(req, networkReconnectCallback);
            Log.i(TAG, "registerNetworkReconnectMonitor: registered");
        } catch (Throwable t) { Log.w(TAG, "registerNetworkReconnectMonitor FAIL: " + t); }
    }

    private void unregisterNetworkReconnectMonitor() {
        if (networkReconnectCallback == null) return;
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) cm.unregisterNetworkCallback(networkReconnectCallback);
        } catch (Throwable t) { Log.d(TAG, "unregisterNetworkReconnectMonitor: " + t); }
        networkReconnectCallback = null;
    }

    // V180: 蓝牙音频断开/重连的"监听与播放控制"已整体迁移到 RadioPlaybackService（FGS 后台可靠）。
    //   Activity 仅保留 notifyJsBtAudioEvent() —— 由 ServiceReceiver 收到 Service 的
    //   BT_DISC/BT_RECONN 广播后调用做 JS/UI 同步；真正的 pause/resume 不依赖 Activity。
    //   回前台 onResume 主动向 Service 查询最新蓝牙断开态，覆盖后台期间发生的断开/恢复。

    private void notifyJsBtAudioEvent(final String kind) {
        final Handler h = new Handler(Looper.getMainLooper());
        h.postDelayed(new Runnable() {
            @Override public void run() {
                try {
                    Bridge b = getBridge();
                    WebView wv = (b != null) ? b.getWebView() : null;
                    if (wv == null) { Log.w(TAG, "[V171-BT] wv null, skip notify (" + kind + ")"); return; }
                    String code;
                    if ("disconnect".equals(kind)) {
                        code = "try{ if(typeof handleBtAudioDisconnect==='function'){ handleBtAudioDisconnect(); } }catch(e){ console.log('[V171-BT] JS disconnect err:',e); }";
                    } else {
                        code = "try{ if(typeof handleBtAudioReconnect==='function'){ handleBtAudioReconnect(); } }catch(e){ console.log('[V171-BT] JS reconnect err:',e); }";
                    }
                    wv.evaluateJavascript(code, null);
                    Log.i(TAG, "[V171-BT] notified JS: " + kind);
                } catch (Throwable t) { Log.w(TAG, "[V171-BT] notifyJs FAIL (" + kind + "): " + t); }
            }
        }, 300L);
    }

    /** V172: 网络恢复通知节流时间戳（15秒内只通知一次JS） */
    private volatile long lastNetNotifyTs = 0L;

    /**
     * V172 FIX(网络切换多次卡顿/无声根因): 统一网络恢复通知门控。
     *   旧问题：Activity层onAvailable + onCapabilitiesChanged + Service层ACTION_RECONNECT
     *   三路都触发JS handleNetworkReconnect → playChannel全量重载打到未就绪网络上 →
     *   报错→退避→下一路又重载 → 多次卡顿；预算耗尽后永久无声。
     *   门控三层：①15秒节流（吸收一次切换的多路触发）②延迟2.5秒（等VALIDATED）
     *   ③触发前查isPlayingN——ExoPlayer(READY/BUFFERING且playWhenReady)已自行恢复
     *   或正在缓冲，完全不打扰，由V164退避自愈。
     */
    private void notifyJsNetworkReconnect() {
        maybeNotifyJsNetworkReconnect("ACT-NET");
    }

    private void maybeNotifyJsNetworkReconnect(final String src) {
        long now = System.currentTimeMillis();
        if (now - lastNetNotifyTs < 15000L) {
            Log.i(TAG, "[" + src + "] reconnect notify throttled (15s)");
            return;
        }
        lastNetNotifyTs = now;
        final Handler h = new Handler(Looper.getMainLooper());
        h.postDelayed(new Runnable() {
            @Override public void run() {
                try {
                    // 门控③：播放器正在播/正在缓冲 → ExoPlayer自愈中，不打扰
                    try {
                        if (nativeAudioPlayer != null && nativeAudioPlayer.isPlayingN()) {
                            Log.i(TAG, "[" + src + "] ExoPlayer is playing/buffering, skip JS reconnect");
                            return;
                        }
                    } catch (Throwable ignore) {}
                    Bridge b = getBridge();
                    WebView wv = (b != null) ? b.getWebView() : null;
                    if (wv == null) { Log.w(TAG, "[" + src + "] wv null, skip"); return; }
                    // 调用 JS 的网络恢复处理函数（app.js 中定义）
                    wv.evaluateJavascript(
                        "try{ if(typeof handleNetworkReconnect==='function'){ handleNetworkReconnect(); } }catch(e){ console.log('[" + src + "] JS err:',e); }",
                        null);
                    Log.i(TAG, "[" + src + "] notified JS (after gate)");
                } catch (Throwable t) { Log.w(TAG, "[" + src + "] notifyJs FAIL: " + t); }
            }
        }, 2500L); // V172: 延迟2.5秒，等网络VALIDATED并稳定
    }

    // ----------------------------------------------------------
    // V80: Atomically install WebView hooks exactly once.
    // ----------------------------------------------------------
    private void installWebViewHooksOnce(WebView wv) {
        if (wv == null) return;
        synchronized (hookLock) {
            if (webViewHooksInstalled) return;
            long t0 = System.currentTimeMillis();
            try {
                // 1. Core WebSettings
                WebSettings s = wv.getSettings();
                if (s != null) {
                    s.setJavaScriptEnabled(true);
                    s.setDomStorageEnabled(true);
                    s.setDatabaseEnabled(true);
                    s.setAllowFileAccess(true);
                    s.setAllowContentAccess(true);
                    s.setMediaPlaybackRequiresUserGesture(false);
                    s.setCacheMode(WebSettings.LOAD_DEFAULT);
                    s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                    // V135: 启用定位 + 定位数据库路径（WebView geolocation API）
                    s.setGeolocationEnabled(true);
                    try { s.setGeolocationDatabasePath(getFilesDir().getPath()); } catch (Throwable t) { Log.d(TAG, "setGeolocationDatabasePath: " + t); }
                    try { s.setJavaScriptCanOpenWindowsAutomatically(true); } catch (Throwable t) { /* ignore */ }
                    try { s.setAllowUniversalAccessFromFileURLs(true); } catch (Throwable t) { Log.d(TAG, "allowUniversalAccessFromFileURLs not available, OK"); }
                    try { s.setAllowFileAccessFromFileURLs(true); } catch (Throwable t) { Log.d(TAG, "allowFileAccessFromFileURLs not available, OK"); }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        try { s.setSafeBrowsingEnabled(false); } catch (Throwable t) { Log.d(TAG, "safeBrowsing toggle not available"); }
                    }
                    try { s.setLayoutAlgorithm(WebSettings.LayoutAlgorithm.NORMAL); } catch (Throwable t) { Log.d(TAG, "setLayoutAlgorithm N/A"); }
                    try { s.setEnableSmoothTransition(false); } catch (Throwable t) { Log.d(TAG, "smoothTransition N/A"); }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                        try { s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW); } catch (Throwable ignoreSafe) { /* already done */ }
                    }
                }
                // Layer type + debugging
                try { wv.setLayerType(WebView.LAYER_TYPE_HARDWARE, null); } catch (Throwable t) { Log.d(TAG, "layerType hwaccel not available"); }
                try { WebView.setWebContentsDebuggingEnabled(true); } catch (Throwable t) { Log.d(TAG, "webContentsDebugging N/A: " + t); }

                // 2. ONE console bridge → ALL console.* calls become
                //    RetroRadioWebConsole lines in adb logcat. If we set this
                //    more than once, we'd overwrite Capacitor's internal
                //    client and lose JS error reporting.
                final WebChromeClient existingCc;
                final WebViewClient existingVc;
                try { existingCc = wv.getWebChromeClient(); } catch (Throwable t) { Log.w(TAG, "getWebChromeClient failed: " + t); throw t; }
                try { existingVc = wv.getWebViewClient(); } catch (Throwable t) { Log.w(TAG, "getWebViewClient failed: " + t); throw t; }

                wv.setWebChromeClient(new WebChromeClient() {
                    @Override
                    public boolean onConsoleMessage(ConsoleMessage cm) {
                        try {
                            if (cm != null) {
                                String line = String.valueOf(cm.messageLevel()) + " | " + cm.message()
                                        + " (src=" + cm.sourceId() + ":" + cm.lineNumber() + ")";
                                int level = cm.messageLevel() == null ? 3 : cm.messageLevel().ordinal();
                                if (level >= ConsoleMessage.MessageLevel.ERROR.ordinal()) {
                                    Log.e("RetroRadioWebConsole", line);
                                } else if (level >= ConsoleMessage.MessageLevel.WARNING.ordinal()) {
                                    Log.w("RetroRadioWebConsole", line);
                                } else {
                                    Log.d("RetroRadioWebConsole", line);
                                }
                            }
                        } catch (Throwable t) {
                            Log.w("RetroRadioWebConsole", "console bridge err: " + t);
                        }
                        if (existingCc != null) {
                            try { return existingCc.onConsoleMessage(cm); } catch (Throwable t) { Log.d(TAG, "existingCc.onConsoleMessage threw (harmless): " + t); }
                        }
                        return super.onConsoleMessage(cm);
                    }
                    @Override public void onProgressChanged(WebView view, int newProgress) {
                        if (existingCc != null) { try { existingCc.onProgressChanged(view, newProgress); } catch (Throwable t) { Log.d(TAG, "existingCc.onProgressChanged: " + t); } }
                        else { super.onProgressChanged(view, newProgress); }
                    }
                    @Override public void onReceivedTitle(WebView view, String title) {
                        if (existingCc != null) { try { existingCc.onReceivedTitle(view, title); } catch (Throwable t) { Log.d(TAG, "existingCc.onReceivedTitle: " + t); } }
                        else { super.onReceivedTitle(view, title); }
                    }
                    // V135: WebView 请求定位（JS 调 navigator.geolocation.getCurrentPosition）时回调
                    // 1) 如果 Android 权限已授予 → 直接通过 origin 权限给 WebView
                    // 2) 如果还没权限 → 先 ActivityCompat 弹系统框，结果在 onRequestPermissionsResult 再 resolve
                    @Override
                    public void onGeolocationPermissionsShowPrompt(String origin,
                                                                   android.webkit.GeolocationPermissions.Callback callback) {
                        try {
                            int f = ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.ACCESS_FINE_LOCATION);
                            int c = ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.ACCESS_COARSE_LOCATION);
                            boolean granted = f == android.content.pm.PackageManager.PERMISSION_GRANTED ||
                                              c == android.content.pm.PackageManager.PERMISSION_GRANTED;
                            if (granted) {
                                Log.i(TAG, "[V135 Geo] origin=" + origin + " → granted via system permission");
                                try { callback.invoke(origin, true, false); } catch (Throwable t) { Log.d(TAG, "geo callback ex: " + t); }
                            } else {
                                Log.i(TAG, "[V135 Geo] origin=" + origin + " → requesting runtime permission");
                                pendingGeoCallback = callback;
                                pendingGeoOrigin = origin;
                                ActivityCompat.requestPermissions(MainActivity.this,
                                    new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION},
                                    REQ_LOCATION);
                            }
                        } catch (Throwable t) {
                            Log.e(TAG, "[V135 Geo] err: " + t, t);
                            // 兜底：拒绝
                            try { callback.invoke(origin, false, false); } catch (Throwable ignore) {}
                        }
                    }
                });

                // 3. ONE shouldInterceptRequest hook → ONLY proxy CNR/CRI
                //    origins that are known to return wrong ACAO (CORS) headers.
                //    V81 REAL ROOT CAUSE FIX: Taiwan b_icecast proxy caused
                //    MEDIA_ERR_SRC_NOT_SUPPORTED for 大千电台 / 寶島新聲
                //    (http://125.227.87.206:8000/FM99.1). User was 100% correct:
                //    Electron does NO proxy for these URLs and they play fine.
                //    So we must NOT intercept Icecast/HLS/ipv4/any-port URLs.
                //    Mixed Content is already gone via androidScheme=http.
                //    复兴电台 (Taiwan HLS) / 大千电台 (Taiwan Icecast) → pass
                //    straight to Chromium, exactly like Electron.
                wv.setWebViewClient(new WebViewClient() {
                    // V168 FIX(恢复数据后双声根因): location.reload()不重建WebView →
                    //   installWebViewHooksOnce的一次性postDelayed注入不会重跑 → 新页面
                    //   __NATIVE_AUDIO_READY永远false → hasNativeAudio()=false → 所有点击走Web引擎
                    //   → 原生ExoPlayer里恢复前的电台没人停 → 双路同时出声！
                    //   onPageFinished每次页面加载(含reload)都重新注入RPC就绪标志。
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        try {
                            String js = "(function(){"
                                + "try{window.__NATIVE_AUDIO_READY=true;console.log('[V168] __NATIVE_AUDIO_READY=true (onPageFinished re-inject)');}catch(e){}"
                                + "try{window.dispatchEvent(new CustomEvent('nativeaudio-ready',{detail:{time:Date.now()}}));}catch(e){}"
                                + "})();";
                            view.evaluateJavascript(js, null);
                            Log.i(TAG, "V168 onPageFinished: re-injected __NATIVE_AUDIO_READY url=" + url);
                        } catch (Throwable t) {
                            Log.w(TAG, "V168 onPageFinished inject err: " + t);
                        }
                        if (existingVc != null) {
                            try { existingVc.onPageFinished(view, url); } catch (Throwable t) { Log.d(TAG, "existingVc.onPageFinished threw (harmless): " + t); }
                        } else {
                            super.onPageFinished(view, url);
                        }
                    }
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                        try {
                            Uri uri = request == null ? null : request.getUrl();
                            if (uri == null) return fallback(existingVc, view, request);
                            String host = uri.getHost();
                            String path = uri.getPath();
                            if (host == null) return fallback(existingVc, view, request);
                            // V118: Native Audio RPC — shouldInterceptRequest 通道 (addJavascriptInterface在ColorOS失效)
                            if (path != null && path.startsWith("/__nativeaudio__/") && nativeAudioPlayer != null) {
                                return handleNativeAudioRpc(uri);
                            }
                            // V144: Native Backup RPC — 同样的 shouldInterceptRequest 通道
                            if (path != null && path.startsWith("/__nativebackup__/")) {
                                return handleNativeBackupRpc(uri, view);
                            }
                            // V106-RISK-SHIELD 白名单爆炸扩展：
                            //   不仅CNR/CRI官方，所有HLS电台的CDN域名都走Native proxy！
                            //   为什么？→ 息屏后WebView JS定时器被冻结，hls.js靠JS去下一个ts分片=失败！
                            //   Java层Native线程不会被冻结 → shouldInterceptRequest在这里把hls的ts/m3u8请求
                            //   全走OkHttp Java线程下=完全绕开JS息屏冻结=息屏HLS也稳定！
                            //   覆盖范围(从全量电台风险扫描1708台top hosts得出)：
                            //     - 央广/国广官方 cnr.cn/cri.cn
                            //     - 蜻蜓FM qtfm.cn/qingting.fm(mp3+hls全量)
                            //     - 喜马拉雅 ximalaya.com/xmcdn.com
                            //     - 阿里云 myalicdn.com/alicdn.com
                            //     - 省级CDN: hndt.com(河南)/vojs.cn(江苏)/hebtv.com(河北)/sxrtv.com(山西)
                            //              /radiofoshan.com.cn(佛山)/iqilu.com(山东)/ynradio.cn(云南)
                            //              /hrbtv.net(黑龙江)/jlntv.cn(吉林)/hljtv.com(黑龙江)/cztvcloud.com(浙江)
                            //              /huaihai.tv(徐州)/yicai.com(一财)/hkcable.com.hk(香港有线)
                            //              /ifeng.com(凤凰)/cgtn.com/cctv.com/cctv.cn(央视/CGTN)/qtv.com.cn
                            //              /akamaized.net(海外Akamai)/amtb.de(华藏)/ddns.net(綠邨)/njgb.com
                            boolean a_cnr = host.endsWith(".cnr.cn") || host.equals("ngcdn002.cnr.cn")
                                    || host.equals("ngcdn001.cnr.cn") || host.equals("satellitepull.cnr.cn")
                                    || host.endsWith(".cri.cn") || host.equals("sk.cri.cn") || host.equals("media.radio.cn")
                                    // === V106 新增：第三方稳定CDN ===
                                    || host.endsWith(".qtfm.cn") || host.endsWith(".qingting.fm")
                                    || host.endsWith(".ximalaya.com") || host.endsWith(".xmcdn.com") || host.contains("fms.od.xiaomi")
                                    || host.endsWith(".alicdn.com") || host.endsWith(".myalicdn.com")
                                    || host.endsWith(".douyincdn.com") || host.endsWith(".douyin.com") || host.endsWith(".huoshan.com")
                                    // === V106 新增：省级官方自建CDN + 其他高频HLS域名 ===
                                    || host.endsWith(".hndt.com") || host.endsWith(".vojs.cn")
                                    || host.endsWith(".hebtv.com") || host.endsWith(".sxrtv.com")
                                    || host.endsWith(".radiofoshan.com.cn") || host.endsWith(".iqilu.com")
                                    || host.endsWith(".ynradio.cn") || host.endsWith(".hrbtv.net")
                                    || host.endsWith(".jlntv.cn") || host.endsWith(".hljtv.com")
                                    || host.endsWith(".cztvcloud.com") || host.endsWith(".huaihai.tv")
                                    || host.endsWith(".yicai.com") || host.endsWith(".hkcable.com.hk")
                                    || host.endsWith(".ifeng.com") || host.endsWith(".cgtn.com")
                                    || host.endsWith(".cctv.com") || host.endsWith(".cctv.cn")
                                    || host.endsWith(".qtv.com.cn") || host.endsWith(".akamaized.net")
                                    || host.endsWith(".amtb.de") || host.endsWith(".ddns.net") || host.endsWith(".njgb.com")
                                    || host.endsWith(".chinabroadcast.cn") || host.equals("english-livetx.cgtn.com")
                                    || host.equals("liveru.cgtn.com") || host.equals("livedoc.cgtn.com") || host.equals("livear.cgtn.com")
                                    // === V106 终极兜底：任何请求只要是 .m3u8 或 .ts 后缀（HLS分片/播放列表），都走Native代理=100%HLS息屏免疫 ===
                                    || (path != null && (path.endsWith(".m3u8") || path.endsWith(".ts")));
                            if (!a_cnr) return fallback(existingVc, view, request);
                            int port = uri.getPort();
                            WebResourceResponse local = proxyStreamRequest(uri.toString(), request.getMethod(), false, false, true);
                            if (local != null) {
                                Log.d("RetroRadioCORS", "PROXY OK [CNR/CRI] "
                                        + host + (port > 0 ? ":" + port : "")
                                        + (path == null ? "" : path));
                                return local;
                            }
                        } catch (Throwable t) {
                            Log.w("RetroRadioCORS", "shouldInterceptRequest unexpected: " + t.getClass().getSimpleName() + " " + t.getMessage());
                        }
                        return fallback(existingVc, view, request);
                    }
                    private WebResourceResponse fallback(WebViewClient vc, WebView v, WebResourceRequest r) {
                        if (vc != null) {
                            try {
                                WebResourceResponse wr = vc.shouldInterceptRequest(v, r);
                                if (wr != null) return wr;
                            } catch (Throwable t) { Log.d("RetroRadioCORS", "existingVc fallback threw (harmless): " + t); }
                        }
                        return null;
                    }
                    // WebView 渲染进程崩溃恢复：防止偶发性 crash 表现为"后台可见但无声，点击图标如冷启动"
                    @Override
                    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                        boolean crashed = (detail != null && detail.didCrash());
                        Log.wtf(TAG, "[RENDER-CRASH] WebView render process gone! didCrash=" + crashed);
                        // 保存崩溃标记，JS 恢复时可据此强制重连播放
                        try {
                            getSharedPreferences("retro_stability", MODE_PRIVATE)
                                .edit().putBoolean("render_crashed", true)
                                .putLong("render_crash_ts", System.currentTimeMillis())
                                .apply();
                        } catch (Throwable ignore) {}
                        // 尝试重新加载页面（localStorage 中的播放状态会自动恢复）
                        try {
                            if (view != null) view.reload();
                            Log.i(TAG, "[RENDER-CRASH] view.reload() issued");
                        } catch (Throwable t) {
                            Log.w(TAG, "[RENDER-CRASH] reload FAIL, restarting Activity: " + t);
                            // reload 失败则重启 Activity 作为最终兜底
                            try {
                                Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
                                if (i != null) {
                                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                                    startActivity(i);
                                    finish();
                                }
                            } catch (Throwable t2) { Log.w(TAG, "[RENDER-CRASH] restart FAIL: " + t2); }
                        }
                        return true; // true = 应用自行处理，阻止系统 crash 弹窗
                    }
                });

                // Force mixed-content mode a second time after setting clients
                try {
                    WebSettings st = wv.getSettings();
                    if (st != null) {
                        st.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                        st.setMediaPlaybackRequiresUserGesture(false);
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                            try { st.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW); } catch (Throwable ignoreSafe) { /* done */ }
                        }
                    }
                    if (Build.VERSION.SDK_INT >= 21) {
                        try {
                            Class<?> cls = wv.getClass();
                            java.lang.reflect.Method m = cls.getMethod("setMixedContentMode", int.class);
                            if (m != null) {
                                m.setAccessible(true);
                                m.invoke(wv, 0 /* MIXED_CONTENT_ALWAYS_ALLOW */);
                            }
                        } catch (Throwable t) { Log.d(TAG, "reflect setMixedContentMode N/A (harmless)"); }
                    }
                } catch (Throwable t) { Log.d(TAG, "post-client settings apply err: " + t); }

                // 4. NativeRadio JS bridge → exposes reportPlaying, wrapProxyUrl etc.
                if (nativeBridgeInstance == null) nativeBridgeInstance = new NativeBridge();
                try {
                    wv.addJavascriptInterface(nativeBridgeInstance, "NativeRadio");
                    Log.i(TAG, "NativeRadio JS interface added via addJavascriptInterface");
                } catch (Throwable t) {
                    Log.wtf(TAG, "NativeRadio addJavascriptInterface FAILED (this is a critical bug!):", t);
                    throw t;
                }

                // 4b. V100 NATIVE-EXOPLAYER: add "NativeAudio" JS interface (bypasses WebView audio engine — immune to ColorOS T+180s ActivityRecord freezer)
                try {
                    // V170: 播放器是进程级单例。Activity被ColorOS锁屏销毁重建时，ExoPlayer和Service
                    //   不受影响继续播放；新Activity只重新拿到同一实例并注册新回调。
                    sActiveWv = wv;
                    final android.webkit.WebView wvFinal = wv;
                    final Handler mainH = new Handler(Looper.getMainLooper());
                    nativeAudioPlayer = NativeAudioPlayer.getShared(MainActivity.this, new NativeAudioPlayer.NativeAudioEvents() {
                            @Override public void onEvent(final String json) {
                                Log.i(TAG, "onEvent received: " + (json.length() > 150 ? json.substring(0,150)+"..." : json));
                                mainH.post(new Runnable() {
                                    @Override public void run() {
                                        try {
                                            // V170: 优先用当前存活Activity的WebView，旧Activity销毁后的回调不会打在死WebView上
                                            android.webkit.WebView wvCur = sActiveWv != null ? sActiveWv : wvFinal;
                                            String js = "(function(){"
                                                    + "try{"
                                                    + "var __d=" + json + ";"
                                                    + "var e=new CustomEvent('nativeaudio',{detail:__d});"
                                                    + "window.dispatchEvent(e);"
                                                    + "console.log('[NativeAudio] dispatched type=' + __d.type + ' isPlaying=' + __d.isPlaying);"
                                                    + "}catch(ex){console.log('NativeAudio dispatchEvent FAIL:',ex.message)};"
                                                    + "})();";
                                            wvCur.evaluateJavascript(js, new android.webkit.ValueCallback<String>() {
                                                @Override public void onReceiveValue(String value) {
                                                    Log.i(TAG, "evaluateJavascript result: " + value);
                                                }
                                            });
                                            Log.i(TAG, "onEvent dispatched via evaluateJavascript");
                                        } catch (Throwable t) {
                                            Log.w(TAG, "NativeAudio dispatch FAIL (activity dead?): " + t.getMessage());
                                        }
                                    }
                                });
                            }
                        });
                    wv.addJavascriptInterface(nativeAudioPlayer, "NativeAudio");
                    Log.i(TAG, "NativeAudio (V100 ExoPlayer native playback) JS interface ADDED OK → bypasses WebView audio renderer");
                    // ══════════════════════════════════════════════════════════════
                    // V112 TIMING FIX: 关键时序修复！
                    //   [ROOT CAUSE] 之前JS window.NativeAudio永远undefined：
                    //   因为 installWebViewHooksOnce 是 postDelayed 60ms起步才执行！
                    //   但 JS init()是WebView加载localhost/index.html完成后立即执行！
                    //   所以 JS init()执行时 addJavascriptInterface 还没调！
                    //   → hasNativeObj=false → 所有FORCE_NATIVE逻辑全白写！
                    //   → CGTN English永远用WebEngine=Chromium自动暂停<video>=锁屏立刻无声！
                    //
                    // 【修复】：addJavascriptInterface完成后，立刻evaluateJavascript通知JS
                    //          告诉JS：Native接口现在注入好了，请重新检查可用性！
                    //          同时playChannel每次都重新typeof，不缓存！
                    // ══════════════════════════════════════════════════════════════
                    try {
                        final WebView wvNotify = wv;
                        final android.os.Handler notifyH = new android.os.Handler(Looper.getMainLooper());
                        // 延迟10ms，确保addJavascriptInterface完成后再触发
                        notifyH.postDelayed(new Runnable() {
                            @Override public void run() {
                                try {
                                    String notifyJs = "(function(){"
                                            + "try{window.__NATIVE_AUDIO_READY=true;console.log('[V118-NATIVE-AUDIO-RPC] window.__NATIVE_AUDIO_READY=true (shouldInterceptRequest RPC channel active, addJavascriptInterface bypassed)');}"
                                            + "catch(setErr){console.warn('[V118] set __NATIVE_AUDIO_READY fail:',setErr.message);}"
                                            + "try{console.log('[V112-NATIVE-AVAILABLE-NOTIFY] Java通知JS：NativeAudio/NativeRadio接口已经注入完成！重新检查可用性！');"
                                            + "try{"
                                            + "if (typeof window.dispatchEvent === 'function') {"
                                            + "window.dispatchEvent(new CustomEvent('nativeaudio-ready',{detail:{time:Date.now()}}));console.log('[V112-NATIVE-AVAILABLE-NOTIFY] nativeaudio-ready事件已派发');"
                                            + "}"
                                            + "}catch(e){console.warn('[V112-NATIVE-AVAILABLE-NOTIFY] dispatch nativeaudio-ready失败(非致命):',e.message);}"
                                            + "}catch(ex){console.warn('[V112-NATIVE-AVAILABLE-NOTIFY] notify失败(非致命):',ex.message);};"
                                            + "})();";
                                    wvNotify.evaluateJavascript(notifyJs, null);
                                    Log.i(TAG, "V112 NativeAudio接口注入完成后→已向JS派发nativeaudio-ready自定义事件（重新检查可用性）");
                                } catch (Throwable notifyErr) {
                                    Log.w(TAG, "V112 notify JS nativeaudio-ready err: " + notifyErr.getMessage());
                                }
                            }
                        }, 10L);
                    } catch (Throwable notifySafeIgnore) {
                        Log.w(TAG, "V112 notify JS nativeaudio-ready wrapper err: " + notifySafeIgnore.getMessage());
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "NativeAudio addJavascriptInterface FAIL (this is a FATAL BUG for lockscreen fix): " + t);
                }

                webViewHooksInstalled = true;
                long dt = System.currentTimeMillis() - t0;
                Log.i(TAG, "installWebViewHooksOnce SUCCESS in " + dt + "ms: settings/console/intercept/NativeBridge all applied");
            } catch (Throwable t) {
                // If hook installation fails, try again on next poll — don't
                // silently give up like V79 did.
                Log.wtf(TAG, "installWebViewHooksOnce FAILED, will retry next poll:", t);
                webViewHooksInstalled = false;
            }
        }
    }

    // --------------- V118: Native Audio RPC via shouldInterceptRequest -------------
    // addJavascriptInterface 在 ColorOS 上失效 (window.NativeAudio=undefined)
    // 改用 shouldInterceptRequest + fetch() 作为 JS→Java RPC 通道
    private WebResourceResponse handleNativeAudioRpc(Uri uri) {
        String path = uri.getPath();
        String action = (path != null && path.startsWith("/__nativeaudio__/"))
                ? path.substring("/__nativeaudio__/".length()) : "";
        boolean isPlaying = false;
        boolean ok = true;
        String err = "";
        try {
            if ("play".equals(action)) {
                String url = uri.getQueryParameter("url");
                String name = uri.getQueryParameter("name");
                String sub = uri.getQueryParameter("sub");
                if (url != null && !url.isEmpty()) {
                    isPlaying = nativeAudioPlayer.playUrlSync(url, name != null ? name : "", sub != null ? sub : "");
                    Log.i(TAG, "V121-RPC play: " + (name != null ? name : "?") + " | isPlaying=" + isPlaying);
                } else {
                    ok = false; err = "missing url param";
                }
            } else if ("stop".equals(action)) {
                nativeAudioPlayer.stop();
                Log.i(TAG, "V121-RPC stop");
                isPlaying = false;
            } else if ("pause".equals(action)) {
                isPlaying = nativeAudioPlayer.pauseSync();
                Log.i(TAG, "V121-RPC pause -> isPlaying=" + isPlaying);
                // V186: 用户UI手动暂停 → 放弃蓝牙整夜等待（仅非BT场景JS才会发此RPC，见app.js case pause门控）
                try {
                    RadioPlaybackService svc = RadioPlaybackService.sLastInstance;
                    if (svc != null) svc.userManualPauseClearsBtWait();
                } catch (Throwable t) { Log.w(TAG, "V186 pause clear-wait err: " + t); }
            } else if ("resume".equals(action)) {
                isPlaying = nativeAudioPlayer.resumeSync();
                Log.i(TAG, "V121-RPC resume -> isPlaying=" + isPlaying);
            } else if ("status".equals(action)) {
                isPlaying = nativeAudioPlayer.isPlayingSync();
                // V137: 返回 hasSource 字段给 JS，让 togglePlay 知道当前 native 是否真的加载了 URL
                //       如果 hasnSource=false，JS 会直接重新 play(url) 而不是调 resume
                boolean hasSrc = false;
                try { hasSrc = nativeAudioPlayer.hasSourceSync(); } catch (Throwable t) { Log.w(TAG, "hasSourceSync err: " + t); hasSrc = false; }
                // V180: 蓝牙断开标志改由 Service(FGS) 权威持有（Activity 后台被冻结也准确），
                //   RPC status 实时读 Service，供 JS watchdog/checkAndResume 阻止误自动恢复。
                boolean btDisc = false;
                try { RadioPlaybackService svc = RadioPlaybackService.sLastInstance; if (svc != null) btDisc = svc.isBtAudioDisconnected(); } catch (Throwable ignore) {}
                String resp2 = "{\"ok\":true,\"isPlaying\":" + isPlaying + ",\"hasSource\":" + hasSrc + ",\"btAudioDisconnected\":" + btDisc + "}";
                java.io.InputStream in2 = new java.io.ByteArrayInputStream(resp2.getBytes());
                java.util.Map<String, String> h2 = new java.util.HashMap<>();
                h2.put("Access-Control-Allow-Origin", "*");
                h2.put("Cache-Control", "no-store");
                h2.put("Content-Type", "application/json;charset=utf-8");
                Log.i(TAG, "V137-RPC status -> isPlaying=" + isPlaying + " hasSource=" + hasSrc);
                return new WebResourceResponse("application/json", "utf-8", 200, "OK", h2, in2);
            } else if ("hasextaudio".equals(action)) {
                // V183: 冷启动续播门控 —— JS查询当前是否有外部音频输出(蓝牙A2DP/有线/USB)。
                //   必须走RPC通道：ColorOS上addJavascriptInterface失效(window.NativeRadio=undefined)，
                //   window.NativeRadio.hasExternalAudioOutput()永远undefined → 误判无输出。
                boolean has = false;
                try { has = RadioPlaybackService.hasExternalAudioOutputStatic(getApplicationContext()); } catch (Throwable t) { Log.w(TAG, "hasextaudio err: " + t); }
                Log.i(TAG, "V183-RPC hasextaudio -> " + has);
                String resp3 = "{\"ok\":true,\"has\":" + has + "}";
                java.io.InputStream in3 = new java.io.ByteArrayInputStream(resp3.getBytes());
                java.util.Map<String, String> h3 = new java.util.HashMap<>();
                h3.put("Access-Control-Allow-Origin", "*");
                h3.put("Cache-Control", "no-store");
                h3.put("Content-Type", "application/json;charset=utf-8");
                return new WebResourceResponse("application/json", "utf-8", 200, "OK", h3, in3);
            } else if ("armbtrestore".equals(action)) {
                // V183: 冷启动"想播放但无外部输出" → 布防，耳机后续连上即自动恢复
                try {
                    RadioPlaybackService svc = RadioPlaybackService.sLastInstance;
                    if (svc != null) {
                        svc.armPendingBtRestore();
                    } else {
                        getSharedPreferences("retro_stability", MODE_PRIVATE)
                                .edit().putBoolean("bt_pending_restore", true).apply();
                        Log.i(TAG, "V183-RPC armbtrestore: Service not ready, persisted flag");
                    }
                } catch (Throwable t) { Log.w(TAG, "armbtrestore err: " + t); }
                String resp4 = "{\"ok\":true}";
                java.io.InputStream in4 = new java.io.ByteArrayInputStream(resp4.getBytes());
                java.util.Map<String, String> h4 = new java.util.HashMap<>();
                h4.put("Access-Control-Allow-Origin", "*");
                h4.put("Cache-Control", "no-store");
                h4.put("Content-Type", "application/json;charset=utf-8");
                return new WebResourceResponse("application/json", "utf-8", 200, "OK", h4, in4);
            } else {
                ok = false; err = "unknown action: " + action;
            }
        } catch (Throwable t) {
            ok = false; err = t.getMessage() != null ? t.getMessage() : String.valueOf(t);
            Log.w(TAG, "V121-RPC " + action + " error: " + t);
        }
        String resp = "{\"ok\":" + ok + ",\"isPlaying\":" + isPlaying + (err.isEmpty() ? "" : ",\"err\":\"" + err.replace("\"","\\\"") + "\"") + "}";
        java.io.InputStream in = new java.io.ByteArrayInputStream(resp.getBytes());
        int statusCode = ok ? 200 : 500;
        java.util.Map<String, String> headers = new java.util.HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", "no-store");
        headers.put("Content-Type", "application/json;charset=utf-8");
        WebResourceResponse wr;
        wr = new WebResourceResponse("application/json", "utf-8", statusCode, "OK", headers, in);
        return wr;
    }

    // --------------- V144: Native Backup RPC via shouldInterceptRequest -------------
    // addJavascriptInterface 在 ColorOS 上失效 (window.NativeRadio=undefined)
    // 改用 shouldInterceptRequest + fetch() + localStorage 中转
    private WebResourceResponse handleNativeBackupRpc(Uri uri, WebView wv) {
        String path = uri.getPath();
        String action = (path != null && path.startsWith("/__nativebackup__/"))
                ? path.substring("/__nativebackup__/".length()) : "";
        Log.i(TAG, "V144-BackupRPC action=" + action);
        try {
            if ("save".equals(action)) {
                // JS 先把 JSON 存到 localStorage.__pending_backup__
                // Java 用 evaluateJavascript 同步读取，然后保存到文件
                String filename = uri.getQueryParameter("filename");
                if (filename == null || filename.isEmpty()) {
                    return jsonRpcResponse(500, "{\"ok\":false,\"err\":\"missing filename\"}");
                }
                // 用 CountDownLatch 同步等待 evaluateJavascript 结果
                final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
                final String[] resultHolder = new String[1];
                final String jsCode = "(function(){try{var v=localStorage.getItem('__pending_backup__');localStorage.removeItem('__pending_backup__');return v||'';}catch(e){return '';}})()";
                final WebView wvRef = wv;
                new android.os.Handler(Looper.getMainLooper()).post(new Runnable() {
                    @Override public void run() {
                        try {
                            wvRef.evaluateJavascript(jsCode, new android.webkit.ValueCallback<String>() {
                                @Override public void onReceiveValue(String value) {
                                    resultHolder[0] = value;
                                    latch.countDown();
                                }
                            });
                        } catch (Throwable t) {
                            Log.e(TAG, "V144-BackupRPC evaluateJavascript FAIL: " + t, t);
                            latch.countDown();
                        }
                    }
                });
                // 等待最多 5 秒
                boolean awaitOk = latch.await(5, java.util.concurrent.TimeUnit.SECONDS);
                if (!awaitOk) {
                    Log.e(TAG, "V144-BackupRPC latch timeout");
                    return jsonRpcResponse(500, "{\"ok\":false,\"err\":\"read localStorage timeout\"}");
                }
                String content = resultHolder[0];
                if (content == null || content.isEmpty() || "null".equals(content) || "\"\"".equals(content)) {
                    Log.e(TAG, "V144-BackupRPC localStorage empty");
                    return jsonRpcResponse(500, "{\"ok\":false,\"err\":\"localStorage __pending_backup__ is empty\"}");
                }
                // evaluateJavascript 返回的值可能带引号和转义（JSON 字符串格式）
                if (content.startsWith("\"") && content.endsWith("\"")) {
                    try {
                        content = new org.json.JSONArray(content).getString(0);
                    } catch (Throwable t) {
                        content = content.substring(1, content.length() - 1)
                                .replace("\\n", "\n")
                                .replace("\\\"", "\"")
                                .replace("\\\\", "\\")
                                .replace("\\/", "/");
                    }
                }
                // V155 FIX: 保存到公共 Downloads 目录，用户能直接在文件管理器看到
                //   之前只存到 getExternalFilesDir (Android/data/.../files) = 沙盒，用户看不到
                File publicDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (publicDir != null && !publicDir.exists()) publicDir.mkdirs();
                File file = null;
                String absPath = "";
                if (publicDir != null && publicDir.exists()) {
                    try {
                        file = new File(publicDir, filename);
                        FileWriter fw = new FileWriter(file);
                        fw.write(content);
                        fw.close();
                        absPath = file.getAbsolutePath();
                        Log.i(TAG, "V155-BackupRPC save to Downloads: " + absPath);
                        // 刷新媒体库，否则"文件管理"看不到这个新文件
                        try {
                            android.media.MediaScannerConnection.scanFile(
                                getApplicationContext(),
                                new String[]{absPath},
                                new String[]{"application/json"},
                                null);
                        } catch (Throwable scanErr) {
                            Log.w(TAG, "V155-BackupRPC mediaScanner FAIL: " + scanErr);
                        }
                    } catch (Throwable sdCardErr) {
                        Log.w(TAG, "V155-BackupRPC save to Downloads FAIL: " + sdCardErr + ", fallback to app-files dir");
                        file = null;
                    }
                }
                // 如果公共目录写入失败（比如没有存储权限），兜底存到应用沙盒目录
                if (file == null) {
                    File dir = getExternalFilesDir(null);
                    if (dir == null) dir = getFilesDir();
                    if (!dir.exists()) dir.mkdirs();
                    file = new File(dir, filename);
                    FileWriter fw = new FileWriter(file);
                    fw.write(content);
                    fw.close();
                    absPath = file.getAbsolutePath();
                    Log.i(TAG, "V155-BackupRPC save to app-files fallback: " + absPath);
                }
                // V150/V155: 两处都清理旧备份（只留10个）
                cleanupOldBackups(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), 10);
                cleanupOldBackups(getExternalFilesDir(null), 10);
                return jsonRpcResponse(200, "{\"ok\":true,\"path\":\"" + absPath.replace("\\", "\\\\") + "\",\"size\":" + content.length() + "}");

            } else if ("saveChannels".equals(action)) {
                // V155: 导出电台列表（与 backup 相同机制，但 localStorage key 不同：__pending_export_channels__）
                String filenameCh = uri.getQueryParameter("filename");
                if (filenameCh == null || filenameCh.isEmpty()) {
                    return jsonRpcResponse(500, "{\"ok\":false,\"err\":\"missing filename\"}");
                }
                final java.util.concurrent.CountDownLatch latchCh = new java.util.concurrent.CountDownLatch(1);
                final String[] resultHolderCh = new String[1];
                final String jsCodeCh = "(function(){try{var v=localStorage.getItem('__pending_export_channels__');localStorage.removeItem('__pending_export_channels__');return v||'';}catch(e){return '';}})()";
                final WebView wvRefCh = wv;
                new android.os.Handler(Looper.getMainLooper()).post(new Runnable() {
                    @Override public void run() {
                        try {
                            wvRefCh.evaluateJavascript(jsCodeCh, new android.webkit.ValueCallback<String>() {
                                @Override public void onReceiveValue(String value) {
                                    resultHolderCh[0] = value;
                                    latchCh.countDown();
                                }
                            });
                        } catch (Throwable t) {
                            Log.e(TAG, "V155-saveChannels evaluateJavascript FAIL: " + t);
                            latchCh.countDown();
                        }
                    }
                });
                if (!latchCh.await(5, java.util.concurrent.TimeUnit.SECONDS)) {
                    return jsonRpcResponse(500, "{\"ok\":false,\"err\":\"read localStorage timeout\"}");
                }
                String contentCh = resultHolderCh[0];
                if (contentCh == null || contentCh.isEmpty() || "null".equals(contentCh) || "\"\"".equals(contentCh)) {
                    return jsonRpcResponse(500, "{\"ok\":false,\"err\":\"localStorage __pending_export_channels__ is empty\"}");
                }
                if (contentCh.startsWith("\"") && contentCh.endsWith("\"")) {
                    try {
                        contentCh = new org.json.JSONArray(contentCh).getString(0);
                    } catch (Throwable t) {
                        contentCh = contentCh.substring(1, contentCh.length() - 1)
                                .replace("\\n", "\n")
                                .replace("\\\"", "\"")
                                .replace("\\\\", "\\")
                                .replace("\\/", "/");
                    }
                }
                // V155: 存到公共 Downloads 目录
                File pubDirCh = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (pubDirCh != null && !pubDirCh.exists()) pubDirCh.mkdirs();
                File fileCh = null;
                String absPathCh = "";
                if (pubDirCh != null && pubDirCh.exists()) {
                    try {
                        fileCh = new File(pubDirCh, filenameCh);
                        java.io.FileWriter fwCh = new java.io.FileWriter(fileCh);
                        fwCh.write(contentCh);
                        fwCh.close();
                        absPathCh = fileCh.getAbsolutePath();
                        try {
                            android.media.MediaScannerConnection.scanFile(
                                    getApplicationContext(),
                                    new String[]{absPathCh},
                                    new String[]{"application/json"},
                                    null);
                        } catch (Throwable ignored) {}
                    } catch (Throwable sdErr) {
                        Log.w(TAG, "V155-saveChannels Downloads FAIL: " + sdErr);
                        fileCh = null;
                    }
                }
                if (fileCh == null) {
                    File dirCh = getExternalFilesDir(null);
                    if (dirCh == null) dirCh = getFilesDir();
                    if (!dirCh.exists()) dirCh.mkdirs();
                    fileCh = new File(dirCh, filenameCh);
                    java.io.FileWriter fwCh = new java.io.FileWriter(fileCh);
                    fwCh.write(contentCh);
                    fwCh.close();
                    absPathCh = fileCh.getAbsolutePath();
                }
                return jsonRpcResponse(200, "{\"ok\":true,\"path\":\"" + absPathCh.replace("\\", "\\\\") + "\",\"size\":" + contentCh.length() + "}");

            } else if ("list".equals(action)) {
                // V155: 同时从 Downloads 公共目录 + 应用沙盒目录收集备份文件
                java.util.Set<String> nameSet = new java.util.HashSet<>();
                java.util.List<String> names = new java.util.ArrayList<>();
                File[] dirsToScan = new File[]{
                        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                        getExternalFilesDir(null),
                        getFilesDir()
                };
                for (File dir : dirsToScan) {
                    File[] files = (dir != null && dir.exists()) ? dir.listFiles() : null;
                    if (files == null) continue;
                    for (File f : files) {
                        if (f.isFile() && f.getName().startsWith("retroradio_backup") && f.getName().endsWith(".json")) {
                            if (nameSet.add(f.getName())) names.add(f.getName());
                        }
                    }
                }
                java.util.Collections.sort(names, java.util.Collections.reverseOrder());
                org.json.JSONArray arr = new org.json.JSONArray();
                for (String n : names) arr.put(n);
                return jsonRpcResponse(200, arr.toString());

            } else if ("read".equals(action)) {
                String filename = uri.getQueryParameter("filename");
                if (filename == null || filename.isEmpty()) {
                    return jsonRpcResponse(500, "{\"ok\":false,\"err\":\"missing filename\"}");
                }
                // V155: 优先从 Downloads 公共目录找，然后是应用沙盒目录
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                File file = (dir != null && dir.exists()) ? new File(dir, filename) : null;
                if (file == null || !file.exists()) {
                    File exDir = getExternalFilesDir(null);
                    if (exDir != null && exDir.exists()) {
                        File f2 = new File(exDir, filename);
                        if (f2.exists()) file = f2;
                    }
                }
                if (file == null || !file.exists()) {
                    File internal = getFilesDir();
                    if (internal != null && internal.exists()) {
                        File f3 = new File(internal, filename);
                        if (f3.exists()) file = f3;
                    }
                }
                if (file == null || !file.exists()) {
                    return jsonRpcResponse(404, "{\"ok\":false,\"err\":\"file not found: " + filename + "\"}");
                }
                FileReader fr = new FileReader(file);
                StringBuilder sb = new StringBuilder();
                char[] buf = new char[8192];
                int n;
                while ((n = fr.read(buf)) > 0) sb.append(buf, 0, n);
                fr.close();
                String content = sb.toString();
                // 返回 JSON 包装的内容
                org.json.JSONObject obj = new org.json.JSONObject();
                obj.put("ok", true);
                obj.put("content", content);
                obj.put("size", content.length());
                return jsonRpcResponse(200, obj.toString());

            // ========== V156: SAF (Storage Access Framework) RPC ==========
            //   safExport / safBackup → CreateDocument 让用户选保存路径
            //   safImport / safRestore → OpenDocument 让用户选文件（替代 <input type=file>）
            } else if ("safExport".equals(action)) {
                String filenameExp = uri.getQueryParameter("filename");
                if (filenameExp == null || filenameExp.isEmpty()) filenameExp = "radio_channels.json";
                safPendingType = "export";
                safPendingSourceKey = "__pending_export_channels__";
                safPendingResultKey = "__saf_result_export__";
                safWvRef = wv;
                final String fExp = filenameExp;
                new Handler(Looper.getMainLooper()).post(() -> {
                    try {
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType("application/json");
                        intent.putExtra(Intent.EXTRA_TITLE, fExp);
                        safCreateDocumentLauncher.launch(intent);
                    } catch (Throwable t) {
                        Log.e(TAG, "V156-safExport launch FAIL: " + t, t);
                        safWriteResult(wv, "__saf_result_export__", "{\"ok\":false,\"err\":\"启动文件选择器失败\"}");
                    }
                });
                return jsonRpcResponse(200, "{\"ok\":true,\"launched\":true,\"resultKey\":\"__saf_result_export__\"}");

            } else if ("safBackup".equals(action)) {
                String filenameBak = uri.getQueryParameter("filename");
                if (filenameBak == null || filenameBak.isEmpty()) filenameBak = "retroradio_backup.json";
                safPendingType = "backup";
                safPendingSourceKey = "__pending_backup__";
                safPendingResultKey = "__saf_result_backup__";
                safWvRef = wv;
                final String fBak = filenameBak;
                new Handler(Looper.getMainLooper()).post(() -> {
                    try {
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType("application/json");
                        intent.putExtra(Intent.EXTRA_TITLE, fBak);
                        safCreateDocumentLauncher.launch(intent);
                    } catch (Throwable t) {
                        Log.e(TAG, "V156-safBackup launch FAIL: " + t, t);
                        safWriteResult(wv, "__saf_result_backup__", "{\"ok\":false,\"err\":\"启动文件选择器失败\"}");
                    }
                });
                return jsonRpcResponse(200, "{\"ok\":true,\"launched\":true,\"resultKey\":\"__saf_result_backup__\"}");

            } else if ("safImport".equals(action)) {
                safPendingType = "import";
                safPendingResultKey = "__saf_result_import__";
                safWvRef = wv;
                new Handler(Looper.getMainLooper()).post(() -> {
                    try {
                        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType("application/json");
                        safOpenDocumentLauncher.launch(intent);
                    } catch (Throwable t) {
                        Log.e(TAG, "V156-safImport launch FAIL: " + t, t);
                        safWriteResult(wv, "__saf_result_import__", "{\"ok\":false,\"err\":\"启动文件选择器失败\"}");
                    }
                });
                return jsonRpcResponse(200, "{\"ok\":true,\"launched\":true,\"resultKey\":\"__saf_result_import__\"}");

            } else if ("safRestore".equals(action)) {
                safPendingType = "restore";
                safPendingResultKey = "__saf_result_restore__";
                safWvRef = wv;
                new Handler(Looper.getMainLooper()).post(() -> {
                    try {
                        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType("application/json");
                        safOpenDocumentLauncher.launch(intent);
                    } catch (Throwable t) {
                        Log.e(TAG, "V156-safRestore launch FAIL: " + t, t);
                        safWriteResult(wv, "__saf_result_restore__", "{\"ok\":false,\"err\":\"启动文件选择器失败\"}");
                    }
                });
                return jsonRpcResponse(200, "{\"ok\":true,\"launched\":true,\"resultKey\":\"__saf_result_restore__\"}");

            } else {
                return jsonRpcResponse(400, "{\"ok\":false,\"err\":\"unknown action: " + action + "\"}");
            }
        } catch (Throwable t) {
            Log.e(TAG, "V144-BackupRPC FAIL: " + t, t);
            return jsonRpcResponse(500, "{\"ok\":false,\"err\":\"" + (t.getMessage() != null ? t.getMessage().replace("\"", "\\\"") : String.valueOf(t)) + "\"}");
        }
    }

    // ========== V156: SAF 辅助函数 ==========
    // 把结果写到 localStorage 的指定 key，JS 端轮询读取
    private void safWriteResult(final WebView wv, final String key, final String jsonVal) {
        if (wv == null || key == null || key.isEmpty()) return;
        final String v = jsonVal == null ? "{}" : jsonVal.replace("\\", "\\\\").replace("'", "\\'");
        final String js = "(function(){try{localStorage.setItem('" + key + "','" + v + "');}catch(e){}})()";
        new Handler(Looper.getMainLooper()).post(() -> {
            try { wv.evaluateJavascript(js, null); } catch (Throwable t) { Log.e(TAG, "safWriteResult FAIL: " + t); }
        });
    }
    // 从 localStorage 读 key，并删除；主线程同步等待结果
    private String safReadLocalStorageAndRemove(final WebView wv, final String key) {
        if (wv == null || key == null || key.isEmpty()) return null;
        final String jsCode = "(function(){try{var v=localStorage.getItem('" + key + "');localStorage.removeItem('" + key + "');return v||'';}catch(e){return '';}})()";
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        final String[] holder = new String[1];
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                wv.evaluateJavascript(jsCode, val -> { holder[0] = val; latch.countDown(); });
            } catch (Throwable t) { Log.e(TAG, "safReadLocalStorage evaluateJavascript FAIL: " + t); latch.countDown(); }
        });
        try { if (!latch.await(5, java.util.concurrent.TimeUnit.SECONDS)) return null; } catch (InterruptedException ie) { return null; }
        String content = holder[0];
        if (content == null || content.isEmpty() || "null".equals(content) || "\"\"".equals(content)) return null;
        if (content.startsWith("\"") && content.endsWith("\"")) {
            try { content = new org.json.JSONArray(content).getString(0); }
            catch (Throwable t) {
                content = content.substring(1, content.length()-1)
                        .replace("\\n","\n").replace("\\\"","\"")
                        .replace("\\\\","\\").replace("\\/","/");
            }
        }
        return content;
    }

    private WebResourceResponse jsonRpcResponse(int statusCode, String body) {
        java.io.InputStream in = new java.io.ByteArrayInputStream(body.getBytes());
        java.util.Map<String, String> headers = new java.util.HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", "no-store");
        headers.put("Content-Type", "application/json;charset=utf-8");
        return new WebResourceResponse("application/json", "utf-8", statusCode, statusCode == 200 ? "OK" : "ERR", headers, in);
    }
    // V150: 清理旧备份文件，保留最新 maxKeep 个
    private void cleanupOldBackups(File dir, int maxKeep) {
        try {
            File[] files = (dir != null && dir.exists()) ? dir.listFiles() : null;
            if (files == null || files.length <= maxKeep) return;
            java.util.List<File> backups = new java.util.ArrayList<>();
            for (File f : files) {
                if (f.isFile() && f.getName().startsWith("retroradio_backup") && f.getName().endsWith(".json")) {
                    backups.add(f);
                }
            }
            if (backups.size() <= maxKeep) return;
            // 按修改时间排序（最老的在前）
            java.util.Collections.sort(backups, new java.util.Comparator<File>() {
                @Override
                public int compare(File a, File b) {
                    return Long.compare(a.lastModified(), b.lastModified());
                }
            });
            int toDelete = backups.size() - maxKeep;
            for (int i = 0; i < toDelete; i++) {
                File old = backups.get(i);
                if (old.delete()) {
                    Log.i(TAG, "V150-BackupCleanup deleted: " + old.getName());
                }
            }
        } catch (Throwable t) {
            Log.e(TAG, "V150-BackupCleanup FAIL: " + t, t);
        }
    }
    private static WebResourceResponse proxyStreamRequest(String urlS, String method0,
                                                          boolean... flags) {
        boolean applyIcyFix = flags.length > 0 && flags[0];
        boolean isHttp = flags.length > 1 && flags[1];
        boolean isCnrCri = flags.length > 2 && flags[2];
        java.io.InputStream in = null;
        java.net.HttpURLConnection hc = null;
        try {
            String method = method0 == null ? "GET" : method0;
            if (applyIcyFix && !"GET".equalsIgnoreCase(method)) method = "GET";
            java.net.URL url = new java.net.URL(urlS);
            java.net.URLConnection conn = url.openConnection();
            conn.setConnectTimeout(9000);
            conn.setReadTimeout(applyIcyFix ? 60000 : 25000);
            conn.setUseCaches(false);
            conn.setAllowUserInteraction(false);
            hc = conn instanceof java.net.HttpURLConnection ? (java.net.HttpURLConnection) conn : null;
            if (hc != null) {
                try {
                    hc.setRequestMethod(method);
                    hc.setInstanceFollowRedirects(true);
                    hc.setDoOutput(false);
                } catch (Throwable t) { Log.w("RetroRadioCORS", "hc setRequestMethod: " + t); }
            }
            if (conn instanceof javax.net.ssl.HttpsURLConnection) {
                try {
                    javax.net.ssl.TrustManager[] trustAll = new javax.net.ssl.TrustManager[]{
                            new javax.net.ssl.X509TrustManager() {
                                public java.security.cert.X509Certificate[] getAcceptedIssuers() { return new java.security.cert.X509Certificate[0]; }
                                public void checkClientTrusted(java.security.cert.X509Certificate[] c, String a) {}
                                public void checkServerTrusted(java.security.cert.X509Certificate[] c, String a) {}
                            }
                    };
                    javax.net.ssl.SSLContext sc = javax.net.ssl.SSLContext.getInstance("TLS");
                    sc.init(null, trustAll, new java.security.SecureRandom());
                    ((javax.net.ssl.HttpsURLConnection)conn).setSSLSocketFactory(sc.getSocketFactory());
                    try { ((javax.net.ssl.HttpsURLConnection)conn).setHostnameVerifier((h,s)->true); } catch (Throwable t) { Log.d("RetroRadioCORS", "hostnameVerifier N/A"); }
                } catch (Throwable t) { Log.w("RetroRadioCORS", "tls trust-all: " + t); }
            }
            if (applyIcyFix) conn.setRequestProperty("Icy-MetaData", "0");
            // V107-HTTPS-CORS-PROXY-FIX: 不管isCnrCri，只要走Native代理→全加标准Chrome UA/Accept/Accept-Encoding
            // 原因：CGTN English等第三方HTTPS CDN(如cgtn.com/ifeng.com/cctv.cn)严格校验UA/Accept
            // 缺UA=返回403=proxyStreamRequest返回null→fallback Chromium原生→息屏JS冻结→锁屏立刻无声！
            // 现在所有走代理的请求都伪装成桌面Chrome=兼容任何CDN
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36");
            conn.setRequestProperty("Accept", "*/*");
            conn.setRequestProperty("Accept-Encoding", "identity"); // 禁用gzip/br，避免解压失败
            conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
            conn.setRequestProperty("Cache-Control", "no-cache");
            conn.setRequestProperty("Pragma", "no-cache");
            // Origin和Referer和目标URL同源=防跨域校验403
            conn.setRequestProperty("Origin", url.getProtocol() + "://" + url.getHost());
            conn.setRequestProperty("Referer", url.getProtocol() + "://" + url.getHost() + "/");
            if (isCnrCri) {
                // 仅CNR/CRI保留额外的特殊处理（如果以后加CDN鉴权扩展）
                if (!"GET".equalsIgnoreCase(method) && !"HEAD".equalsIgnoreCase(method) && hc != null) {
                    try { hc.setRequestMethod(method); } catch (Throwable ignoreSafe) {/*no-op*/}
                }
            }
            conn.connect();
            int status = 200;
            String statusMsg = "OK";
            String contentType = null;
            String encoding = "utf-8";
            if (hc != null) {
                try { status = hc.getResponseCode(); statusMsg = hc.getResponseMessage(); }
                catch (Throwable t) { Log.w("RetroRadioCORS", "getResponseCode " + urlS.substring(0,Math.min(80,urlS.length())) + ": " + t); }
                if (status >= 400) {
                    // V107: 打印4xx/5xx错误细节，方便调试CGTN 403问题
                    String errSample = "";
                    try {
                        java.io.InputStream eIn = null;
                        try { eIn = hc.getErrorStream(); } catch (Throwable ignoreSafe) {}
                        if (eIn != null) {
                            byte[] buf = new byte[128];
                            int r = eIn.read(buf);
                            if (r > 0) errSample = new String(buf, 0, r, "UTF-8").replaceAll("\r?\n"," ").substring(0,Math.min(96,r));
                            try { eIn.close(); } catch (Throwable ignoreSafe) {}
                        }
                    } catch (Throwable ignoreSafe) {}
                    closeStream(in);
                    try { if (hc != null) hc.disconnect(); } catch (Throwable ignoreSafe) {/*no-op*/}
                    Log.w("RetroRadioCORS", "PROXY SKIP server-error status=" + status + " msg=" + statusMsg + " url=" + urlS.substring(0,Math.min(80,urlS.length())) + (errSample.isEmpty()?"":" errBody=["+errSample+"]"));
                    return null;
                }
                try { in = hc.getInputStream(); }
                catch (Throwable t) { Log.w("RetroRadioCORS", "getInputStream " + urlS.substring(0,Math.min(80,urlS.length())) + ": " + t); in = null; }
            } else {
                try { in = conn.getInputStream(); } catch (Throwable t) { Log.w("RetroRadioCORS", "conn.getInputStream: " + t); in = null; }
            }
            if (in == null) { Log.w("RetroRadioCORS", "PROXY NULL stream " + urlS.substring(0,Math.min(80,urlS.length()))); return null; }
            String ct = conn.getContentType();
            if (ct != null && !ct.isEmpty()) {
                int sc = ct.indexOf(';');
                if (sc > 0) {
                    contentType = ct.substring(0, sc).trim();
                    String low = ct.toLowerCase(java.util.Locale.ROOT);
                    int csi = low.indexOf("charset=");
                    if (csi > 0) {
                        String enc = ct.substring(csi + 8).trim();
                        int q1 = enc.indexOf(';'); if (q1 > 0) enc = enc.substring(0, q1).trim();
                        if (enc.startsWith("\"") && enc.endsWith("\"") && enc.length() > 2) enc = enc.substring(1, enc.length() - 1);
                        if (!enc.isEmpty()) encoding = enc;
                    }
                } else {
                    contentType = ct.trim();
                }
            }
            if (contentType == null || contentType.isEmpty() || contentType.equalsIgnoreCase("application/octet-stream")) {
                String path = url.getPath();
                if (path != null) {
                    String pl = path.toLowerCase(java.util.Locale.ROOT);
                    if (pl.endsWith(".m3u8")) contentType = "application/vnd.apple.mpegurl";
                    else if (pl.endsWith(".m3u")) contentType = "audio/x-mpegurl";
                    else if (pl.endsWith(".ts")) contentType = "video/mp2t";
                    else if (pl.endsWith(".aac")) contentType = "audio/aac";
                    else if (pl.endsWith(".mp3")) contentType = "audio/mpeg";
                    else if (pl.endsWith(".wav")) contentType = "audio/wav";
                    else if (pl.endsWith(".flac")) contentType = "audio/flac";
                    else if (pl.endsWith(".ogg") || pl.endsWith(".opus")) contentType = "audio/ogg";
                }
                if ((contentType == null || contentType.isEmpty() || contentType.equalsIgnoreCase("application/octet-stream"))) {
                    if (applyIcyFix) contentType = "audio/mpeg";
                    else if (isHttp) contentType = guessAudioContentTypeFromUrl(urlS);
                }
                if (contentType == null) contentType = "application/octet-stream";
            }
            java.util.Map<String, String> respHeaders = new java.util.HashMap<>();
            if (isCnrCri) {
                respHeaders.put("Access-Control-Allow-Origin", "*");
                respHeaders.put("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
                respHeaders.put("Access-Control-Allow-Headers", "*");
            }
            respHeaders.put("Cache-Control", "no-cache");
            WebResourceResponse wr = new WebResourceResponse(contentType, encoding, in);
            try { wr.setStatusCodeAndReasonPhrase(status, (statusMsg == null || statusMsg.isEmpty()) ? "OK" : statusMsg); }
            catch (Throwable ignoreSafe) {/*no-op*/}
            try { wr.setResponseHeaders(respHeaders); } catch (Throwable ignoreSafe) {/*no-op*/}
            Log.d("RetroRadioCORS", "PROXY OK icy=" + applyIcyFix + " http=" + isHttp + " cnr=" + isCnrCri
                    + " " + status + " " + url.getHost() + (url.getPort() > 0 ? ":" + url.getPort() : "")
                    + (url.getPath() == null ? "" : url.getPath()) + " ct=" + contentType);
            return wr;
        } catch (Throwable t) {
            closeStream(in);
            try { if (hc != null) hc.disconnect(); } catch (Throwable ignoreSafe) {/*no-op*/}
            Log.w("RetroRadioCORS", "PROXY FAIL " + urlS + ": " + t.getClass().getSimpleName() + " " + t.getMessage());
            return null;
        }
    }

    private static String guessAudioContentTypeFromUrl(String urlS) {
        if (urlS == null) return "application/octet-stream";
        String low = urlS.toLowerCase(java.util.Locale.ROOT);
        if (low.contains(".m3u8")) return "application/vnd.apple.mpegurl";
        if (low.contains(".m3u")) return "audio/x-mpegurl";
        if (low.contains(".ts")) return "video/mp2t";
        if (low.contains(".aac")) return "audio/aac";
        if (low.contains(".flac")) return "audio/flac";
        if (low.contains(".wav")) return "audio/wav";
        if (low.contains(".ogg") || low.contains(".opus")) return "audio/ogg";
        if (low.contains(".mp3")
                || low.contains("fm99") || low.contains("fm98")
                || low.contains("/fm") || low.contains("/stream") || low.contains("/listen")
                || low.contains(":8000") || low.contains(":8001") || low.contains(":8080")
                || low.contains("shoutcast") || low.contains("icecast") || low.contains("radio")) {
            return "audio/mpeg";
        }
        return "application/octet-stream";
    }

    private static void closeStream(java.io.InputStream in) {
        try { if (in != null) in.close(); } catch (Throwable t) { Log.d(TAG, "closeStream: " + t); }
    }

    @Override
    public void onStart() { super.onStart(); }

    @Override
    public void onResume() {
        super.onResume();
        try {
            WebView wv = getBridge() != null ? getBridge().getWebView() : null;
            if (wv != null) {
                wv.onResume();
                try { wv.resumeTimers(); } catch (Throwable t) { Log.d(TAG, "onResume resumeTimers: " + t); }
                try { WebSettings s = wv.getSettings(); if (s != null) {
                    s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                    s.setDomStorageEnabled(true);
                    s.setMediaPlaybackRequiresUserGesture(false);
                } } catch (Throwable t) { Log.d(TAG, "onResume settings: " + t); }
            }
        } catch (Throwable t) { Log.d(TAG, "onResume wv: " + t); }
        // V180: 回前台时向 Service(FGS) 拉取权威蓝牙断开态并同步 JS。
        //   后台期间 Activity 被冻结/重建，可能漏掉 Service 的 BT_DISC/BT_RECONN 广播，
        //   导致 JS 的 _btAudioDisconnected 与实际不符（断了没置位 → 误自动恢复；恢复了卡 true → 误阻止）。
        try {
            RadioPlaybackService svc = RadioPlaybackService.sLastInstance;
            final boolean btDisc = svc != null && svc.isBtAudioDisconnected();
            WebView wv2 = getBridge() != null ? getBridge().getWebView() : null;
            if (wv2 != null) {
                wv2.evaluateJavascript(
                    "try{window._setBtAudioDisconnected&&window._setBtAudioDisconnected(" + btDisc + ");}catch(e){}", null);
                Log.i(TAG, "[V180-BT] onResume 从Service同步蓝牙断开态=" + btDisc);
            }
        } catch (Throwable t) { Log.d(TAG, "onResume bt state sync: " + t); }
    }

    @Override public void onPause() {
        super.onPause();
        // ══════════════════════════════════════════════════════════════
        // V109-NO-WEBVIEW-ONPAUSE: ROOT CAUSE FIX FOR "锁屏立刻无声/开屏立刻恢复"
        //
        // 【实锤根因】：
        //   2026-08-02 20:25 logcat 100%精确匹配：
        //   1) 用户点CGTN - English → hasNativeObj=false (NativeAudio JS接口未注册成功)
        //      → FORCE_NATIVE逻辑完全失效 → 继续使用WebEngine hls.js播放
        //   2) WebEngine → cr_MediaCodecBridge创建视频解码器 c2.mtk.avc.decoder (320x180真视频HLS)
        //   3) 用户按下电源键锁屏 → MTK_APPList MainActivity state:PAUSED
        //      → MainActivity.onPause() → 旧代码 if(wv!=null) wv.onPause() 执行
        //
        // 【Android官方文档 wv.onPause() 的副作用】：
        //   "Pauses any extra processing associated with this WebView...
        //    When called, this WebView will also **PAUSE ALL TIMERS, SUSPEND RENDERING,
        //    AND PAUSE JAVASCRIPT globally on all WebViews in the process.**"
        //   → 直接副作用：所有<video>/<audio>元素被IMMEDIATELY PAUSE！=立刻无声！
        //   → 用户按电源开屏 → MainActivity.onResume() → wv.onResume() → <video>恢复 = 立刻有声！
        //   → 100%完美匹配用户所有现象！！
        //
        // 【产品需求 vs 系统默认】：
        //   系统默认wv.onPause()是为了"用户离开APP=不需要播放了=省电"
        //   但我们产品="复古收音机锁屏后台播放" = 锁屏必须继续播放！需求完全相反！
        //
        // 【副作用评估】：
        //   - 不调用wv.onPause() = 锁屏后JS/hls.js/<video>继续跑
        //   - 这正是我们要的！！
        //   - 而且我们已经有4层保活：前台Service + PARTIAL_WAKE_LOCK + WiFi_MODE_FULL_HIGH_PERF双锁 + MediaSession
        //     → 完全兼容，零额外副作用！
        // ══════════════════════════════════════════════════════════════
        // 【关键】：注释掉 wv.onPause() 这一行就解决！
        // try { WebView wv = getBridge() != null ? getBridge().getWebView() : null; if (wv != null) wv.onPause(); }
        // catch (Throwable t) { Log.d(TAG, "onPause wv: " + t); }
        try {
            android.util.Log.i(TAG, "[V109-NO-WEBVIEW-ONPAUSE] 锁屏不暂停WebView播放！(避免wv.onPause()=立刻暂停<audio>/<video>=锁屏无声)");
        } catch (Throwable ignoreSafe) {}
    }
    @Override public void onStop() { super.onStop(); }
    @Override public void onRestart() {
        super.onRestart();
        try { WebView wv = getBridge() != null ? getBridge().getWebView() : null; if (wv != null) wv.resumeTimers(); }
        catch (Throwable t) { Log.d(TAG, "onRestart resumeTimers: " + t); }
    }

    @Override
    public void onDestroy() {
        unregisterReceiverSafe();
        unbindServiceSafe();
        unregisterNetworkReconnectMonitor();
        // V180: 蓝牙监听归属 Service，Activity onDestroy 无需注销
        // V170 STABILITY(锁屏无声根因): Activity被ColorOS锁屏/后台销毁时，绝不能释放播放器！
        //   NativeAudioPlayer是进程级单例(appCtx绑定Service)，ExoPlayer继续在系统media cgroup播放。
        //   旧代码这里release() → ExoPlayer销毁+Service stopSelf → 锁屏即无声，解锁才重播。
        try { if (nativeAudioPlayer != null) nativeAudioPlayer.setEvents(null); } catch (Throwable ignore) {}
        try { if (sActiveWv != null) sActiveWv = null; } catch (Throwable ignore) {}
        Log.i(TAG, "onDestroy (V170: player singleton kept alive)");
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        try { WebView wv = getBridge() != null ? getBridge().getWebView() : null; if (wv != null && wv.canGoBack()) { wv.goBack(); return; } }
        catch (Throwable t) { Log.d(TAG, "onBackPressed: " + t); }
        moveTaskToBack(true);
    }

    @Override public void onLowMemory() {
        super.onLowMemory();
        try { Runtime.getRuntime().gc(); } catch (Throwable t) { Log.d(TAG, "onLowMemory gc: " + t); }
    }

    @Override public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        try { if (level >= TRIM_MEMORY_BACKGROUND) Runtime.getRuntime().gc(); } catch (Throwable t) { Log.d(TAG, "onTrimMemory gc: " + t); }
    }

    // V135: Activity 请求权限的结果回调 — 处理定位
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        try {
            if (requestCode == REQ_LOCATION && pendingGeoCallback != null) {
                boolean granted = false;
                if (grantResults != null && grantResults.length > 0) {
                    for (int r : grantResults) {
                        if (r == android.content.pm.PackageManager.PERMISSION_GRANTED) { granted = true; break; }
                    }
                }
                Log.i(TAG, "[V135 Geo Result] origin=" + pendingGeoOrigin + " granted=" + granted);
                try { pendingGeoCallback.invoke(pendingGeoOrigin, granted, false); } catch (Throwable t) { Log.d(TAG, "geo cb result ex: " + t); }
                pendingGeoCallback = null;
                pendingGeoOrigin = null;
            }
        } catch (Throwable t) {
            Log.e(TAG, "[V135 Geo Result] err: " + t, t);
            try { if (pendingGeoCallback != null && pendingGeoOrigin != null) pendingGeoCallback.invoke(pendingGeoOrigin, false, false); } catch (Throwable ignore) {}
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
        }
    }

    private void registerServiceReceiver() {
        serviceReceiver = new ServiceReceiver();
        IntentFilter f = new IntentFilter(RadioPlaybackService.UI_ACTION_UPDATE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(serviceReceiver, f, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(serviceReceiver, f);
        }
    }

    private void registerDebugEvalReceiver() {
        try {
            debugEvalReceiver = new DebugEvalReceiver();
            IntentFilter f = new IntentFilter(DEBUG_ACTION_EVAL_JS);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(debugEvalReceiver, f, Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(debugEvalReceiver, f);
            }
            Log.d(TAG, "Debug eval receiver registered for action: " + DEBUG_ACTION_EVAL_JS);
        } catch (Throwable t) {
            Log.e(TAG, "registerDebugEvalReceiver FAIL: " + t, t);
        }
    }

    private void unregisterReceiverSafe() {
        try { if (serviceReceiver != null) unregisterReceiver(serviceReceiver); } catch (Throwable t) { Log.d(TAG, "unreg serviceReceiver: " + t); }
        serviceReceiver = null;
        try { if (debugEvalReceiver != null) unregisterReceiver(debugEvalReceiver); } catch (Throwable t) { Log.d(TAG, "unreg debugEvalReceiver: " + t); }
        debugEvalReceiver = null;
    }

    private void bindService() {
        try {
            Intent i = new Intent(this, RadioPlaybackService.class);
            startService(i);
            bindService(i, connection, Context.BIND_AUTO_CREATE);
        } catch (Throwable t) { Log.w(TAG, "bindService FAIL: " + t); }
    }

    private void unbindServiceSafe() {
        try { if (serviceBound) { unbindService(connection); serviceBound = false; } } catch (Throwable t) { Log.d(TAG, "unbindService: " + t); }
    }

    private void sendCommandToService(String action, String name, String subtitle, Boolean playing) {
        try {
            Intent i = new Intent(MainActivity.this, RadioPlaybackService.class);
            i.setAction(action);
            if (name != null) i.putExtra(RadioPlaybackService.EXTRA_NAME, name);
            if (subtitle != null) i.putExtra(RadioPlaybackService.EXTRA_SUBTITLE, subtitle);
            if (playing != null) i.putExtra(RadioPlaybackService.EXTRA_IS_PLAYING, playing);
            startService(i);
        } catch (Throwable t) { Log.w(TAG, "sendCommandToService FAIL action=" + action + ": " + t); }
    }

    private void dispatchJsEvent(String type, String payload) {
        try {
            Bridge b = getBridge();
            if (b == null) { Log.w(TAG, "dispatchJsEvent type=" + type + ": bridge NULL"); return; }
            WebView wv = b.getWebView();
            if (wv == null) { Log.w(TAG, "dispatchJsEvent type=" + type + ": wv NULL"); return; }
            JSONObject d = new JSONObject();
            try {
                d.put("type", type == null ? "" : type);
                if (payload != null && payload.length() > 0) {
                    try { d.put("payload", new JSONObject(payload)); }
                    catch (Throwable pm) { d.put("payload", payload); }
                } else {
                    d.put("payload", new JSONObject());
                }
            } catch (Throwable t) { Log.w(TAG, "dispatchJsEvent payload JSON: " + t); }
            String escaped = JSONObject.quote(d.toString()).replace("'", "\\'");
            final String code = "try{window.dispatchEvent(new CustomEvent('nativeRadio',{detail:JSON.parse(" + escaped + ")}))}catch(e){}";
            wv.post(new Runnable() { @Override public void run() { try { wv.evaluateJavascript(code, null); } catch (Throwable t) { Log.w(TAG, "dispatchJsEvent evaluateJavascript: " + t); } } });
        } catch (Throwable t) { Log.w(TAG, "dispatchJsEvent FAIL type=" + type + ": " + t); }
    }

    public class NativeBridge {
        private static final String TAG_B = "RetroRadioBridge";

        @JavascriptInterface
        public void reportPlaying(String name, String subtitle) {
            playingFlag = true;
            currentName = name == null ? "" : name;
            currentSubtitle = subtitle == null ? "" : subtitle;
            Log.d(TAG_B, "reportPlaying name=" + currentName + " sub=" + currentSubtitle);
            sendCommandToService(RadioPlaybackService.ACTION_META, currentName, currentSubtitle, true);
        }
        @JavascriptInterface
        public void reportPaused(String name, String subtitle) {
            playingFlag = false;
            currentName = name == null ? "" : name;
            currentSubtitle = subtitle == null ? "" : subtitle;
            Log.d(TAG_B, "reportPaused name=" + currentName + " sub=" + currentSubtitle);
            sendCommandToService(RadioPlaybackService.ACTION_META, currentName, currentSubtitle, false);
        }
        @JavascriptInterface
        public void reportStopped() {
            playingFlag = false;
            currentName = ""; currentSubtitle = "";
            Log.d(TAG_B, "reportStopped");
            sendCommandToService(RadioPlaybackService.ACTION_STOP, null, null, null);
        }
        @JavascriptInterface
        public void reportMeta(String name, String subtitle, boolean playing) {
            playingFlag = playing;
            currentName = name == null ? "" : name;
            currentSubtitle = subtitle == null ? "" : subtitle;
            Log.d(TAG_B, "reportMeta playing=" + playing + " name=" + currentName);
            sendCommandToService(RadioPlaybackService.ACTION_META, currentName, currentSubtitle, playing);
        }
        @JavascriptInterface
        public boolean playUrl(final String url, final String name, final String subtitle) {
            try {
                if (url == null || url.length() == 0) return false;
                playingFlag = true;
                currentName = name == null ? "" : name;
                currentSubtitle = subtitle == null ? "" : subtitle;
                Log.d(TAG_B, "playUrl (MediaSession-only) name=" + currentName + " url=" + url);
                sendCommandToService(RadioPlaybackService.ACTION_META, currentName, currentSubtitle, true);
                return true;
            } catch (Throwable t) {
                Log.e(TAG_B, "playUrl FAIL: " + t, t);
                return false;
            }
        }
        @JavascriptInterface
        public boolean stopPlayer() {
            try {
                playingFlag = false;
                currentName = ""; currentSubtitle = "";
                Log.d(TAG_B, "stopPlayer");
                sendCommandToService(RadioPlaybackService.ACTION_STOP, null, null, null);
                return true;
            } catch (Throwable t) { Log.w(TAG_B, "stopPlayer FAIL: " + t); return false; }
        }
        @JavascriptInterface
        public boolean togglePlayNative() {
            try {
                Intent i = new Intent(MainActivity.this, RadioPlaybackService.class);
                i.setAction(RadioPlaybackService.ACTION_TOGGLE);
                startService(i);
                Log.d(TAG_B, "togglePlayNative OK");
                return true;
            } catch (Throwable t) { Log.w(TAG_B, "togglePlayNative FAIL: " + t); return false; }
        }
        @JavascriptInterface
        public boolean isNativePlaying() { return playingFlag; }
        @JavascriptInterface
        public boolean isIgnoringBatteryOptimizations() {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                    return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
                }
            } catch (Throwable t) { Log.d(TAG_B, "isIgnoringBatteryOptimizations: " + t); }
            return true;
        }
        @JavascriptInterface
        public boolean requestIgnoreBatteryOptimizations() {
            try {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                if (pm == null) return false;
                if (pm.isIgnoringBatteryOptimizations(getPackageName())) return true;
                // OPPO ColorOS AppFrozen 防护：主动请求加入电池优化白名单
                Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(Uri.parse("package:" + getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                Log.i(TAG_B, "requestIgnoreBatteryOptimizations: prompted user (防 AppFrozen)");
                return true;
            } catch (Throwable t) { Log.w(TAG_B, "requestIgnoreBatteryOptimizations FAIL: " + t); return false; }
        }
        // V183: 冷启动自动续播门控 —— 仅当蓝牙耳机/有线/USB等外部输出在线时，JS才自动恢复播放，
        //   杜绝app重启后手机扬声器自己突然响。判定逻辑与RadioPlaybackService完全一致。
        @JavascriptInterface
        public boolean hasExternalAudioOutput() {
            try {
                return RadioPlaybackService.hasExternalAudioOutputStatic(getApplicationContext());
            } catch (Throwable t) { Log.d(TAG_B, "hasExternalAudioOutput: " + t); return false; }
        }

        // V183: JS冷启动发现"上次在播放但耳机未连" → 通知Service布防，耳机后续连上即自动恢复
        @JavascriptInterface
        public void armPendingBtRestore() {
            try {
                RadioPlaybackService svc = RadioPlaybackService.sLastInstance;
                if (svc != null) {
                    svc.armPendingBtRestore();
                } else {
                    // Service尚未bind就绪：持久化标志，Service onCreate注册监听时自行消费
                    getSharedPreferences("retro_stability", MODE_PRIVATE)
                            .edit().putBoolean("bt_pending_restore", true).apply();
                    Log.d(TAG_B, "V183 armPendingBtRestore: Service not ready, persisted flag for onCreate");
                }
            } catch (Throwable t) { Log.d(TAG_B, "armPendingBtRestore: " + t); }
        }

        @JavascriptInterface
        public boolean wasRenderCrashed() {
            try {
                SharedPreferences sp = getSharedPreferences("retro_stability", MODE_PRIVATE);
                boolean crashed = sp.getBoolean("render_crashed", false);
                if (crashed) {
                    sp.edit().putBoolean("render_crashed", false).apply(); // 读取后清除
                }
                return crashed;
            } catch (Throwable t) { Log.d(TAG_B, "wasRenderCrashed: " + t); return false; }
        }
        @JavascriptInterface
        public String getAppInfo() {
            try {
                JSONObject o = new JSONObject();
                o.put("sdk", Build.VERSION.SDK_INT);
                o.put("brand", Build.BRAND);
                o.put("model", Build.MODEL);
                o.put("appVersion", "1.3.82");
                o.put("build", "V82");
                ActivityManager am = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
                o.put("memoryClass", am != null ? am.getMemoryClass() : -1);
                return o.toString();
            } catch (Throwable t) { Log.w(TAG_B, "getAppInfo FAIL: " + t); return "{}"; }
        }
        @JavascriptInterface
        public boolean hasLocationGranted() {
            try {
                int f = ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.ACCESS_FINE_LOCATION);
                int c = ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.ACCESS_COARSE_LOCATION);
                return f == android.content.pm.PackageManager.PERMISSION_GRANTED ||
                       c == android.content.pm.PackageManager.PERMISSION_GRANTED;
            } catch (Throwable t) { Log.d(TAG_B, "hasLocationGranted: " + t); return false; }
        }

        // V80 identity implementation: androidScheme=http means no Mixed Content,
        // so wrapping through 127.0.0.1 is no longer needed. Keep method so old
        // frontends / cached JS don't throw ReferenceError; just return the URL.
        @JavascriptInterface
        public String wrapProxyUrl(String url) {
            Log.d(TAG_B, "wrapProxyUrl called (V80 identity) → url=" + (url == null ? "null" : url.substring(0, Math.min(url.length(), 96))));
            return url;
        }

        // V143: 用户数据备份 - 保存到 app external files dir
        @JavascriptInterface
        public String saveBackupFile(String filename, String content) {
            try {
                File dir = getExternalFilesDir(null);
                if (dir == null) dir = getFilesDir();
                if (!dir.exists()) dir.mkdirs();
                File file = new File(dir, filename);
                FileWriter fw = new FileWriter(file);
                fw.write(content);
                fw.close();
                Log.i(TAG_B, "saveBackupFile: " + file.getAbsolutePath() + " (" + content.length() + " chars)");
                return file.getAbsolutePath();
            } catch (Throwable t) {
                Log.e(TAG_B, "saveBackupFile FAIL: " + t);
                return null;
            }
        }

        // V143: 列出所有备份文件
        @JavascriptInterface
        public String listBackupFiles() {
            try {
                File dir = getExternalFilesDir(null);
                if (dir == null) return "[]";
                File[] files = dir.listFiles();
                if (files == null) return "[]";
                java.util.List<String> names = new java.util.ArrayList<>();
                for (File f : files) {
                    if (f.isFile() && f.getName().startsWith("retroradio_backup") && f.getName().endsWith(".json")) {
                        names.add(f.getName());
                    }
                }
                java.util.Collections.sort(names, java.util.Collections.reverseOrder());
                org.json.JSONArray arr = new org.json.JSONArray();
                for (String n : names) arr.put(n);
                return arr.toString();
            } catch (Throwable t) {
                Log.e(TAG_B, "listBackupFiles FAIL: " + t);
                return "[]";
            }
        }

        // V143: 读取备份文件内容
        @JavascriptInterface
        public String readBackupFile(String filename) {
            try {
                File dir = getExternalFilesDir(null);
                if (dir == null) return null;
                File file = new File(dir, filename);
                FileReader fr = new FileReader(file);
                StringBuilder sb = new StringBuilder();
                char[] buf = new char[4096];
                int n;
                while ((n = fr.read(buf)) > 0) sb.append(buf, 0, n);
                fr.close();
                return sb.toString();
            } catch (Throwable t) {
                Log.e(TAG_B, "readBackupFile FAIL: " + t);
                return null;
            }
        }
    }

    private class DebugEvalReceiver extends BroadcastReceiver {
        @Override public void onReceive(Context context, Intent intent) {
            try {
                final String code = intent.getStringExtra(DEBUG_EXTRA_JS);
                if (code == null) { Log.w(TAG, "DebugEvalReceiver: no js extra"); return; }
                Log.d(TAG, "DebugEvalReceiver JS length=" + code.length());
                final Handler h = new Handler(Looper.getMainLooper());
                h.post(new Runnable() {
                    @Override public void run() {
                        try {
                            Bridge b = getBridge();
                            if (b == null) { Log.w(TAG, "DebugEvalReceiver: bridge null"); return; }
                            WebView wv = b.getWebView();
                            if (wv == null) { Log.w(TAG, "DebugEvalReceiver: wv null"); return; }
                            wv.evaluateJavascript(code, null);
                            Log.d(TAG, "DebugEvalReceiver evaluateJavascript OK");
                        } catch (Throwable t) { Log.e(TAG, "DebugEvalReceiver exec FAIL: " + t, t); }
                    }
                });
            } catch (Throwable t) { Log.e(TAG, "DebugEvalReceiver FAIL: " + t, t); }
        }
    }

    private class ServiceReceiver extends BroadcastReceiver {
        @Override public void onReceive(Context context, Intent intent) {
            try {
                String event = intent.getStringExtra(RadioPlaybackService.EXTRA_UI_EVENT);
                if (event == null) return;
                switch (event) {
                    case RadioPlaybackService.ACTION_PLAY:
                        dispatchJsEvent("play", "{}"); break;
                    case RadioPlaybackService.ACTION_PAUSE:
                        dispatchJsEvent("pause", "{}"); break;
                    case RadioPlaybackService.ACTION_STOP:
                        dispatchJsEvent("stop", "{}"); break;
                    case RadioPlaybackService.ACTION_NEXT:
                        dispatchJsEvent("next", "{}"); break;
                    case RadioPlaybackService.ACTION_PREV:
                        dispatchJsEvent("prev", "{}"); break;
                    case RadioPlaybackService.ACTION_ERROR:
                        dispatchJsEvent("nativePlaybackError", "{}"); break;
                    case RadioPlaybackService.ACTION_RECONNECT:
                        // V152: Service 层网络恢复通知 → V172: 走统一门控（节流+播放中跳过）
                        try {
                            maybeNotifyJsNetworkReconnect("SVC-NET");
                        } catch (Throwable t) { Log.w(TAG, "[SVC-NET-RECONNECT] FAIL: " + t); }
                        break;
                    // V180: 蓝牙断开/恢复由 Service(FGS) 主导，Activity 仅同步 JS 标志与 UI
                    case RadioPlaybackService.ACTION_BT_DISCONNECTED:
                        try { notifyJsBtAudioEvent("disconnect"); } catch (Throwable t) { Log.w(TAG, "[V180-BT] ui disc FAIL: " + t); }
                        break;
                    case RadioPlaybackService.ACTION_BT_RECONNECTED:
                        try { notifyJsBtAudioEvent("reconnect"); } catch (Throwable t) { Log.w(TAG, "[V180-BT] ui reconn FAIL: " + t); }
                        break;
                    default:
                        Log.d(TAG, "ServiceReceiver unknown event: " + event);
                }
            } catch (Throwable t) { Log.w(TAG, "ServiceReceiver FAIL: " + t); }
        }
    }
}
