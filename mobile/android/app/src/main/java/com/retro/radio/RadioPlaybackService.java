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
import android.net.wifi.WifiManager;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;
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
        try { if (!wifiLock.isHeld()) wifiLock.acquire(); } catch (Throwable ignore) {}
    }

    private void releaseLocks() {
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Throwable ignore) {}
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Throwable ignore) {}
    }

    private void handlePlay(boolean notifyUi) {
        if (!requestAudioFocus()) {
            Log.w(TAG, "handlePlay: AudioFocus request FAIL");
        }
        acquireLocks();
        isPlaying = true;
        stateBuilder.setState(PlaybackStateCompat.STATE_PLAYING, 0, 1.0f);
        try { mediaSession.setPlaybackState(stateBuilder.build()); } catch (Throwable ignore) {}
        try { mediaSession.setActive(true); } catch (Throwable ignore) {}
        startForeground(NOTIFICATION_ID, buildNotification());
        updateNotification();
        if (notifyUi) sendBroadcastToUI(ACTION_PLAY);
        else Log.d(TAG, "handlePlay: internal state update only (skip broadcast to UI)");
    }

    private void handlePause(boolean notifyUi) {
        isPlaying = false;
        stateBuilder.setState(PlaybackStateCompat.STATE_PAUSED, 0, 1.0f);
        try { mediaSession.setPlaybackState(stateBuilder.build()); } catch (Throwable ignore) {}
        try { mediaSession.setActive(true); } catch (Throwable ignore) {}
        try { stopForeground(STOP_FOREGROUND_DETACH); } catch (Throwable ignore) {
            try { stopForeground(false); } catch (Throwable ig) {}
        }
        updateNotification();
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
    public void onDestroy() {
        Log.d(TAG, "onDestroy");
        try { unregisterReceiver(uiReceiver); } catch (Throwable ignore) {}
        try { if (mediaSession != null) { mediaSession.setActive(false); mediaSession.release(); } } catch (Throwable ignore) {}
        releaseLocks();
        abandonAudioFocus();
        try { notificationManager.cancel(NOTIFICATION_ID); } catch (Throwable ignore) {}
        super.onDestroy();
    }
}
