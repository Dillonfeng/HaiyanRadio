package com.retro.radio;

import androidx.media3.common.C;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.util.UnstableApi;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * V191 横屏双声道机械 VU 表 —— 真实电平取样器。
 * =============================================================================
 * 挂在 ExoPlayer/DefaultAudioSink 的 AudioProcessor 链上，对 PCM 做【透传】
 * （零修改、零重采样、零拷贝，queueInput 收到的 buffer 原样从 getOutput 吐出），
 * 仅在音频线程顺手按声道统计每块 RMS，供横屏 VU 表 30Hz 轮询。
 *
 * 兼容：
 *  - ENCODING_PCM_16BIT / ENCODING_PCM_FLOAT（setEnableAudioFloatOutput(true)
 *    时链上通常已是 FLOAT）
 *  - mono（channelCount=1，大量网络电台为单声道）→ 左右电平平齐
 *  - 统计值写 volatile，RPC(shouldInterceptRequest) 线程无锁直读
 *
 * 开销：每块（约 20~50ms 音频）一次线性遍历 + 一次 sqrt，<0.1% 单核；
 *       不横屏时 JS 不轮询，本类除该遍历外零活动、零锁、零定时器。
 * =============================================================================
 */
@UnstableApi
public final class VuMeterAudioProcessor implements AudioProcessor {

    /** 单块最多参与统计的帧数，防止异常大块造成长循环（通常每块≤2048帧）。 */
    private static final int MAX_FRAMES_PER_BLOCK = 2048;
    /** RMS 死区，压制数字底噪让指针静息（约 -54dBFS）。 */
    private static final float NOISE_GATE = 0.002f;

    private int sampleRate = 44100;
    private int channelCount = 2;
    private int encoding = C.ENCODING_INVALID;
    private boolean active;

    // 透传输出缓冲（direct，native order，按块容量复用；每块约 10~50ms，几~十几 KB）
    private ByteBuffer outBuffer = EMPTY_BUFFER;
    private ByteBuffer pendingBuffer = EMPTY_BUFFER;
    private boolean inputEnded;

    // 0..1 线性 RMS，音频线程写 / RPC 线程读
    private volatile float levelL = 0f;
    private volatile float levelR = 0f;
    // V200：块内峰值（|sample| 最大值），起音不被块平均稀释，供表头"跟手"供能
    private volatile float peakL = 0f;
    private volatile float peakR = 0f;

    public float getLevelL() { return levelL; }
    public float getLevelR() { return levelR; }
    public float getPeakL() { return peakL; }
    public float getPeakR() { return peakR; }

    @Override
    public AudioFormat configure(AudioFormat inputFormat) throws UnhandledAudioFormatException {
        if (inputFormat.encoding != C.ENCODING_PCM_16BIT
                && inputFormat.encoding != C.ENCODING_PCM_FLOAT) {
            throw new UnhandledAudioFormatException(inputFormat);
        }
        this.sampleRate = inputFormat.sampleRate;
        this.channelCount = Math.max(1, inputFormat.channelCount);
        this.encoding = inputFormat.encoding;
        this.active = true;
        // passthrough：原样返回输入格式，不新增/删除处理器效果
        return inputFormat;
    }

    @Override
    public boolean isActive() {
        return active;
    }

    @Override
    public void queueInput(ByteBuffer input) {
        final int size = input.remaining();
        if (size <= 0) return;
        analyzeBlock(input);
        // ExoPlayer 契约：返回前 input.position 必须推进到 limit。
        // 数据原样拷贝进自有 direct 缓冲，由 getOutput 交回链下游（passthrough）。
        if (outBuffer.capacity() < size) {
            outBuffer = ByteBuffer.allocateDirect(size).order(ByteOrder.nativeOrder());
        }
        outBuffer.clear();
        outBuffer.limit(size);
        outBuffer.put(input); // put(ByteBuffer)：读 input position→limit，推进 input.position 到 limit
        outBuffer.flip();
        pendingBuffer = outBuffer;
    }

    @Override
    public void queueEndOfStream() {
        inputEnded = true;
    }

    @Override
    public ByteBuffer getOutput() {
        ByteBuffer b = pendingBuffer;
        pendingBuffer = EMPTY_BUFFER;
        return b;
    }

    @Override
    public boolean isEnded() {
        return inputEnded && pendingBuffer == EMPTY_BUFFER;
    }

    @Override
    public void flush() {
        pendingBuffer = EMPTY_BUFFER;
        inputEnded = false;
    }

    @Override
    public void reset() {
        flush();
        active = false;
        encoding = C.ENCODING_INVALID;
        levelL = 0f;
        levelR = 0f;
        peakL = 0f;
        peakR = 0f;
    }

    // ------------------------------------------------------------------
    // 电平统计（音频线程）。duplicate() 出独立 position 的只读视图，
    // 绝不触碰原 buffer 的 position（透传契约）。
    // V207：块内按 SEGMENT 帧分段即时刷新 volatile —— 整块(≤2048帧≈46ms)攒完
    // 才更新一次会让轮询拿到最多 ~70ms 龄期的旧值（滞后难消），且块尾一次
    // 大阶跃是表针颤动的燃料；12ms 级小步进既降龄期又让弹道更平顺。
    // ------------------------------------------------------------------
    private static final int SEGMENT_FRAMES = 512;

    private void analyzeBlock(ByteBuffer buf) {
        try {
            final int pos = buf.position();
            final int lim = buf.limit();
            final int bytes = lim - pos;
            if (bytes <= 0) return;
            final int bytesPerSample = (encoding == C.ENCODING_PCM_FLOAT) ? 4 : 2;
            final int frameSize = bytesPerSample * channelCount;
            if (frameSize <= 0) return;
            final int frames = Math.min(bytes / frameSize, MAX_FRAMES_PER_BLOCK);
            if (frames <= 0) return;

            final ByteBuffer ro = buf.order(ByteOrder.LITTLE_ENDIAN)
                    .duplicate().order(ByteOrder.LITTLE_ENDIAN);
            final boolean isFloat = (encoding != C.ENCODING_PCM_16BIT);

            for (int segStart = 0; segStart < frames; segStart += SEGMENT_FRAMES) {
                final int segEnd = Math.min(segStart + SEGMENT_FRAMES, frames);
                final int n = segEnd - segStart;
                double sumL = 0d, sumR = 0d;
                double pkL = 0d, pkR = 0d;
                for (int i = segStart; i < segEnd; i++) {
                    final int off = pos + i * frameSize;
                    if (isFloat) {
                        double l = clampF(ro.getFloat(off));
                        if (l < 0) l = -l;
                        if (l > pkL) pkL = l;
                        sumL += l * l;
                        if (channelCount >= 2) {
                            double r = clampF(ro.getFloat(off + 4));
                            if (r < 0) r = -r;
                            if (r > pkR) pkR = r;
                            sumR += r * r;
                        }
                    } else {
                        double l = ro.getShort(off) / 32768.0;
                        if (l < 0) l = -l;
                        if (l > pkL) pkL = l;
                        sumL += l * l;
                        if (channelCount >= 2) {
                            double r = ro.getShort(off + 2) / 32768.0;
                            if (r < 0) r = -r;
                            if (r > pkR) pkR = r;
                            sumR += r * r;
                        }
                    }
                }
                float rmsL = (float) Math.sqrt(sumL / n);
                float rmsR;
                float peakL = (float) pkL;
                float peakR;
                if (channelCount >= 2) {
                    rmsR = (float) Math.sqrt(sumR / n);
                    peakR = (float) pkR;
                } else {
                    rmsR = rmsL; // mono：两表同步
                    peakR = peakL;
                }
                if (rmsL < NOISE_GATE) rmsL = 0f;
                if (rmsR < NOISE_GATE) rmsR = 0f;
                if (peakL < NOISE_GATE) peakL = 0f;
                if (peakR < NOISE_GATE) peakR = 0f;
                levelL = rmsL;
                levelR = rmsR;
                this.peakL = peakL;
                this.peakR = peakR;
            }
        } catch (Throwable t) {
            // 取样器绝不允许影响播放主链路
            levelL = 0f;
            levelR = 0f;
            peakL = 0f;
            peakR = 0f;
        }
    }

    private static double clampF(float v) {
        if (Float.isNaN(v) || Float.isInfinite(v)) return 0d;
        if (v > 1f) return 1d;
        if (v < -1f) return -1d;
        return v;
    }
}
