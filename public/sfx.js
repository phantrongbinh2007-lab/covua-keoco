/**
 * Âm thanh tổng hợp bằng Web Audio API — không cần file .mp3
 */
let audioCtx = null;
let muted = localStorage.getItem('chessTugMuted') === '1';
let lastUrgentSecond = null;
let lastCountdownSec = null;

function getCtx() {
    if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
    }
    return audioCtx;
}

export function unlockAudio() {
    const ctx = getCtx();
    if (!ctx) return;
    // beep cực ngắn để mở khóa trên iOS/Chrome
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.01);
}

export function isMuted() {
    return muted;
}

export function setMuted(value) {
    muted = !!value;
    localStorage.setItem('chessTugMuted', muted ? '1' : '0');
    return muted;
}

export function toggleMute() {
    return setMuted(!muted);
}

function tone({ freq = 440, duration = 0.12, type = 'sine', volume = 0.08, slideTo = null, delay = 0 }) {
    if (muted) return;
    const ctx = getCtx();
    if (!ctx) return;

    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo != null) {
        osc.frequency.linearRampToValueAtTime(slideTo, t0 + duration);
    }

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
}

function noiseBurst({ duration = 0.08, volume = 0.04, delay = 0 }) {
    if (muted) return;
    const ctx = getCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const len = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 800;
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + duration + 0.02);
}

/** Đếm ngược giải / vòng: mỗi giây một tiếng, 3-2-1 cao hơn, GO mạnh */
export function playCountdownTick(seconds) {
    if (seconds === lastCountdownSec) return;
    lastCountdownSec = seconds;

    if (seconds <= 0) {
        // GO!
        tone({ freq: 523, duration: 0.1, type: 'square', volume: 0.07 });
        tone({ freq: 659, duration: 0.12, type: 'square', volume: 0.07, delay: 0.1 });
        tone({ freq: 784, duration: 0.22, type: 'square', volume: 0.09, delay: 0.2 });
        lastCountdownSec = null;
        return;
    }
    if (seconds <= 3) {
        tone({ freq: 880 + (3 - seconds) * 120, duration: 0.16, type: 'triangle', volume: 0.1 });
        return;
    }
    tone({ freq: 520, duration: 0.08, type: 'sine', volume: 0.05 });
}

export function resetCountdownMemory() {
    lastCountdownSec = null;
}

/** Nước đi đúng */
export function playMoveCorrect() {
    tone({ freq: 660, duration: 0.07, type: 'sine', volume: 0.06 });
    tone({ freq: 880, duration: 0.1, type: 'sine', volume: 0.05, delay: 0.06 });
}

/** Nước sai */
export function playMoveWrong() {
    tone({ freq: 220, duration: 0.18, type: 'sawtooth', volume: 0.05, slideTo: 140 });
}

/** Máy / đối thủ trên puzzle đi */
export function playComputerMove() {
    tone({ freq: 390, duration: 0.05, type: 'triangle', volume: 0.035 });
}

/** Giải xong puzzle — kéo dây */
export function playRopePull(isMe) {
    noiseBurst({ duration: 0.1, volume: 0.045 });
    if (isMe) {
        tone({ freq: 392, duration: 0.1, type: 'square', volume: 0.06 });
        tone({ freq: 523, duration: 0.14, type: 'square', volume: 0.07, delay: 0.09 });
        tone({ freq: 659, duration: 0.18, type: 'square', volume: 0.07, delay: 0.18 });
    } else {
        tone({ freq: 349, duration: 0.12, type: 'square', volume: 0.055, slideTo: 260 });
        tone({ freq: 220, duration: 0.16, type: 'triangle', volume: 0.05, delay: 0.1 });
    }
}

/** Vào Sudden Death */
export function playSuddenDeath() {
    tone({ freq: 180, duration: 0.2, type: 'sawtooth', volume: 0.06 });
    tone({ freq: 240, duration: 0.15, type: 'square', volume: 0.05, delay: 0.15 });
    tone({ freq: 360, duration: 0.25, type: 'square', volume: 0.07, delay: 0.28 });
}

/** Timer gấp (mỗi giây khi ≤10s) */
export function playTimerUrgent(secondsLeft) {
    if (secondsLeft === lastUrgentSecond) return;
    lastUrgentSecond = secondsLeft;
    if (secondsLeft <= 0) {
        lastUrgentSecond = null;
        return;
    }
    const freq = secondsLeft <= 3 ? 920 : 700;
    tone({ freq, duration: 0.05, type: 'square', volume: secondsLeft <= 3 ? 0.07 : 0.04 });
}

export function resetUrgentMemory() {
    lastUrgentSecond = null;
}

/** Thắng / thua trận */
export function playMatchWin() {
    tone({ freq: 523, duration: 0.12, type: 'triangle', volume: 0.07 });
    tone({ freq: 659, duration: 0.12, type: 'triangle', volume: 0.07, delay: 0.12 });
    tone({ freq: 784, duration: 0.12, type: 'triangle', volume: 0.07, delay: 0.24 });
    tone({ freq: 1046, duration: 0.28, type: 'triangle', volume: 0.08, delay: 0.36 });
}

export function playMatchLose() {
    tone({ freq: 392, duration: 0.15, type: 'triangle', volume: 0.05, slideTo: 280 });
    tone({ freq: 247, duration: 0.28, type: 'sine', volume: 0.06, delay: 0.14 });
}

/** Hòa puzzle / đổi bài */
export function playPuzzleDraw() {
    tone({ freq: 440, duration: 0.08, type: 'sine', volume: 0.04 });
    tone({ freq: 370, duration: 0.1, type: 'sine', volume: 0.04, delay: 0.09 });
}
