package com.retro.radio;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * V188-C: 开机自启恢复"蓝牙等待播放"布防。
 *
 * 背景：2026-09-14 凌晨 02:20 手机 OTA 升级自动重启（sys.boot.reason=reboot,ota），
 * 整夜等待布防随进程死亡丢失，早上开蓝牙音箱无声。等待意图(bt_wait_intent_v186)虽已
 * 持久化在 SharedPreferences，但此前没有任何组件在开机后拉起 Service 去消费它。
 *
 * 行为：仅在等待意图为 true 时 startForegroundService 拉起 RadioPlaybackService
 * （ACTION_BT_WAIT_REARM）。Service 冷启动 onCreate→registerBtAudioMonitor 会按意图
 * 完成布防：无外部输出→近静音轨+90秒闹钟等待；音箱已在开机后连回→3秒确认自动恢复。
 * 用户从未在等待中（意图为false）→ 不做任何事，绝不开机自动放声音。
 *
 * 注意：ColorOS 需要用户在 设置→应用管理→海燕收音机→自启动 授权后才会投递
 * BOOT_COMPLETED；未授权时本接收器收不到（系统行为，非代码问题）。
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "RetroRadioBoot";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            return;
        }
        boolean wait = false;
        try {
            wait = RadioPlaybackService.peekBtWaitIntent(context);
        } catch (Throwable ignore) {}
        Log.i(TAG, "BOOT_COMPLETED received, btWaitIntent=" + wait);
        if (!wait) return;  // 没有等待中的播放意愿 → 开机保持安静
        try {
            Intent svc = new Intent(context, RadioPlaybackService.class);
            svc.setAction(RadioPlaybackService.ACTION_BT_WAIT_REARM);
            androidx.core.content.ContextCompat.startForegroundService(context, svc);
            Log.i(TAG, "V188: foreground service started to re-arm BT wait (near-silent + alarm)");
        } catch (Throwable t) {
            Log.w(TAG, "V188: start service on boot FAIL: " + t);
        }
    }
}
