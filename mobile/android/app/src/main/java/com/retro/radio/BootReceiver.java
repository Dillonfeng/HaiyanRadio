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
 * 行为：等待意图为 true，或持久化存在最后播放电台(V191：手动暂停后开机也允许音箱接入
 * 自动续播)时，startForegroundService 拉起 RadioPlaybackService（ACTION_BT_WAIT_REARM）。
 * V192 例外：用户上次是"划掉退出"的（user_exited_v192=true）且无等待意图 → 开机保持安静，
 * 绝不在用户没打开过 App 的情况下自动响起。Service 冷启动 onCreate→registerBtAudioMonitor
 * 完成布防：无外部输出→安静等待（等待意图在时加近静音轨+闹钟）；音箱已连回→3秒确认自动
 * 恢复。从未播放过 → 不开机自动放声音。安全：所有自动播放都有外部 sink 二次确认，
 * 手机喇叭绝不自动响。
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
        boolean userExited = false;
        try {
            userExited = RadioPlaybackService.peekUserExited(context);
        } catch (Throwable ignore) {}
        boolean hasLastChannel = false;
        try {
            String url = context.getSharedPreferences(NativeAudioPlayer.LAST_CH_SP, Context.MODE_PRIVATE)
                    .getString(NativeAudioPlayer.LC_URL, "");
            hasLastChannel = url != null && !url.isEmpty();
        } catch (Throwable ignore) {}
        Log.i(TAG, "BOOT_COMPLETED received, btWaitIntent=" + wait + ", hasLastChannel=" + hasLastChannel
                + ", userExited=" + userExited);
        // V192: 用户划掉退出后重启 → 保持安静（无等待意图时退出态一票否决）
        if (!wait && (!hasLastChannel || userExited)) return;
        try {
            Intent svc = new Intent(context, RadioPlaybackService.class);
            svc.setAction(RadioPlaybackService.ACTION_BT_WAIT_REARM);
            androidx.core.content.ContextCompat.startForegroundService(context, svc);
            Log.i(TAG, "V191: foreground service started on boot (wait=" + wait
                    + ", lastChannel=" + hasLastChannel + ")");
        } catch (Throwable t) {
            Log.w(TAG, "V188: start service on boot FAIL: " + t);
        }
    }
}
