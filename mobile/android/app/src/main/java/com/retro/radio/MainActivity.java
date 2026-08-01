package com.retro.radio;

import android.Manifest;
import android.app.ActivityManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.ServiceConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.ConsoleMessage;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.MimeTypeMap;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import android.util.Log;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

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
    // WebView hooks are applied ONCE, the first time the bridge/wv becomes
    // non-null. Previously we installed WebChromeClient/WebViewClient from 3
    // different places (fixWebViewSettings + repeatedlyEnsure loop idx2+
    // optimizeWebViewPower) which caused the last writer to win and earlier
    // hooks (console bridge, NativeRadio interface) to be silently discarded
    // → 0 RetroRadio lines in logcat, which made all prior "analysis" blind
    // guesswork. Now we apply hooks atomically and log if they fail.
    private volatile boolean webViewHooksInstalled = false;
    private final Object hookLock = new Object();
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
        Log.i(TAG, "onCreate BEGIN app=v1.3.82 / buildV82 / androidScheme=http / badge=about / no-play-toast");
        registerServiceReceiver();
        registerDebugEvalReceiver();
        bindService();
        // V80: install hooks from the first non-null WebView moment, then never
        // touch them again. Poll every 60ms for up to ~2.4s (enough for even
        // the slowest ColorOS bridge init).
        final Handler h = new Handler(Looper.getMainLooper());
        for (int i = 0; i < 40; i++) {
            final int idx = i;
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
            }, i * 60L);
        }
        Log.i(TAG, "onCreate END");
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
                    @Override
                    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                        try {
                            Uri uri = request == null ? null : request.getUrl();
                            if (uri == null) return fallback(existingVc, view, request);
                            String host = uri.getHost();
                            String path = uri.getPath();
                            if (host == null) return fallback(existingVc, view, request);
                            // V81: ONLY CNR/CRI official domains that reliably
                            // return broken ACAO headers get proxied. Everything
                            // else (台湾 Icecast / 复兴电台 HLS / 省级电台 etc.)
                            // is left to Chromium exactly as Electron does it.
                            boolean a_cnr = host.endsWith(".cnr.cn") || host.equals("ngcdn002.cnr.cn")
                                    || host.equals("ngcdn001.cnr.cn") || host.equals("satellitepull.cnr.cn")
                                    || host.endsWith(".cri.cn") || host.equals("sk.cri.cn") || host.equals("media.radio.cn");
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

    // --------------- CORS / ICY proxy for CNR/CRI + legacy Icecast only -------------
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
            if (isCnrCri) {
                if (!"GET".equalsIgnoreCase(method) && !"HEAD".equalsIgnoreCase(method) && hc != null) {
                    try { hc.setRequestMethod(method); } catch (Throwable ignoreSafe) {/*no-op*/}
                }
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36");
                conn.setRequestProperty("Accept", "*/*");
                conn.setRequestProperty("Accept-Encoding", "identity");
                conn.setRequestProperty("Origin", url.getProtocol() + "://" + url.getHost());
                conn.setRequestProperty("Referer", url.getProtocol() + "://" + url.getHost() + "/");
            }
            conn.connect();
            int status = 200;
            String statusMsg = "OK";
            String contentType = null;
            String encoding = "utf-8";
            if (hc != null) {
                try { status = hc.getResponseCode(); statusMsg = hc.getResponseMessage(); }
                catch (Throwable t) { Log.w("RetroRadioCORS", "getResponseCode " + urlS + ": " + t); }
                if (status >= 400) {
                    closeStream(in);
                    try { if (hc != null) hc.disconnect(); } catch (Throwable ignoreSafe) {/*no-op*/}
                    Log.w("RetroRadioCORS", "PROXY SKIP server-error " + status + " " + urlS);
                    return null;
                }
                try { in = hc.getInputStream(); }
                catch (Throwable t) { Log.w("RetroRadioCORS", "getInputStream " + urlS + ": " + t); in = null; }
            } else {
                try { in = conn.getInputStream(); } catch (Throwable t) { Log.w("RetroRadioCORS", "conn.getInputStream: " + t); in = null; }
            }
            if (in == null) { Log.w("RetroRadioCORS", "PROXY NULL stream " + urlS); return null; }
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
    }

    @Override public void onPause() {
        super.onPause();
        try { WebView wv = getBridge() != null ? getBridge().getWebView() : null; if (wv != null) wv.onPause(); }
        catch (Throwable t) { Log.d(TAG, "onPause wv: " + t); }
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
        Log.i(TAG, "onDestroy");
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
                    default:
                        Log.d(TAG, "ServiceReceiver unknown event: " + event);
                }
            } catch (Throwable t) { Log.w(TAG, "ServiceReceiver FAIL: " + t); }
        }
    }
}
