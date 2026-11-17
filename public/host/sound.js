// 効果音とBGM（M7）。
// 音声ファイルは使わず、Web Audio API でその場で音を合成する。
// ファイルの読み込み失敗やライセンスの心配がなく、発表用PCに持ち込むものも増えない。
import { SOUND_VOLUME, BGM_VOLUME, BGM_TEMPO } from '../../config.js';

const STORAGE_KEY = 'tilt-maze:sound';

// 音名 → 周波数（A4 = 440Hz を基準に、半音ごとに 2^(1/12) 倍）
const NOTE = (n) => 440 * 2 ** ((n - 69) / 12);

// BGM の譜面（16分音符 × 16 = 1小節を4小節）。数字は MIDI のノート番号、null は休み
const BASS = [
  45, null, 45, null, 52, null, 45, null, 43, null, 43, null, 50, null, 43, null,
  41, null, 41, null, 48, null, 41, null, 40, null, 40, null, 47, null, 44, null,
];
const LEAD = [
  69, 72, 76, 72, 69, 72, 76, 79, 67, 71, 74, 71, 67, 71, 74, 77,
  65, 69, 72, 69, 65, 69, 72, 76, 64, 68, 71, 68, 64, 68, 71, 76,
];

export function createSound() {
  let ctx = null;
  let master = null;
  let enabled = load();
  let bgmTimer = null;
  let bgmStep = 0;
  let bgmNextAt = 0;

  function load() {
    try { return localStorage.getItem(STORAGE_KEY) !== 'off'; } catch { return true; }
  }

  /**
   * AudioContext はユーザーがクリックやキー入力をした後でないと音を出せない（ブラウザの決まり）。
   * そのため最初の操作のときにここを呼んで準備する。
   */
  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = enabled ? SOUND_VOLUME : 0;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  /** 1音を鳴らす。slideTo を付けると音程を滑らせる（落下音など） */
  function tone(freq, at, dur, { type = 'square', vol = 0.2, slideTo = null, dest = master } = {}) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
    // 音の出だしと終わりを少しなめらかにして「プツッ」というノイズを防ぐ
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(vol, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(dest);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  const EFFECTS = {
    count: (t) => tone(NOTE(69), t, 0.15),
    go: (t) => tone(NOTE(81), t, 0.4),
    fall: (t) => tone(600, t, 0.55, { type: 'sawtooth', vol: 0.18, slideTo: 60 }),
    checkpoint: (t) => {
      tone(NOTE(76), t, 0.12, { type: 'triangle', vol: 0.3 });
      tone(NOTE(83), t + 0.1, 0.25, { type: 'triangle', vol: 0.3 });
    },
    goal: (t) => {
      [72, 76, 79, 84].forEach((n, i) => tone(NOTE(n), t + i * 0.11, 0.25, { vol: 0.2 }));
      tone(NOTE(88), t + 0.46, 0.7, { type: 'triangle', vol: 0.3 });
    },
    timeout: (t) => {
      tone(NOTE(64), t, 0.25, { type: 'sawtooth', vol: 0.18 });
      tone(NOTE(57), t + 0.25, 0.6, { type: 'sawtooth', vol: 0.18, slideTo: NOTE(45) });
    },
    pilot: (t) => tone(NOTE(79), t, 0.1, { type: 'triangle', vol: 0.2 }),
  };

  function play(name) {
    if (!enabled || !unlock()) return;
    EFFECTS[name]?.(ctx.currentTime + 0.01);
  }

  // ---------- BGM ----------
  // 少し先（0.3秒ぶん）の音までまとめて予約しておく方式。
  // setInterval は遅れることがあるが、音の時刻は AudioContext の正確な時計で決まるのでリズムが崩れない
  let bgmGain = null;
  function scheduleBgm() {
    const sixteenth = 60 / BGM_TEMPO / 4;
    while (bgmNextAt < ctx.currentTime + 0.3) {
      const i = bgmStep % BASS.length;
      if (BASS[i] != null) tone(NOTE(BASS[i]), bgmNextAt, sixteenth * 1.8, { type: 'triangle', vol: 0.5, dest: bgmGain });
      if (LEAD[i] != null) tone(NOTE(LEAD[i]), bgmNextAt, sixteenth * 0.9, { type: 'square', vol: 0.12, dest: bgmGain });
      bgmNextAt += sixteenth;
      bgmStep++;
    }
  }

  function startBgm() {
    if (bgmTimer || !unlock()) return;
    bgmGain = ctx.createGain();
    bgmGain.gain.value = BGM_VOLUME;
    bgmGain.connect(master);
    bgmStep = 0;
    bgmNextAt = ctx.currentTime + 0.05;
    scheduleBgm();
    bgmTimer = setInterval(scheduleBgm, 100);
  }

  function stopBgm() {
    clearInterval(bgmTimer);
    bgmTimer = null;
    if (bgmGain && ctx) {
      // ブツッと切れないよう 0.3 秒でフェードアウト
      const g = bgmGain;
      g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08);
      setTimeout(() => g.disconnect(), 500);
      bgmGain = null;
    }
  }

  function setEnabled(on) {
    enabled = on;
    try { localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off'); } catch { /* 無視 */ }
    if (master) master.gain.setTargetAtTime(on ? SOUND_VOLUME : 0, ctx.currentTime, 0.05);
  }

  return {
    play,
    startBgm,
    stopBgm,
    get enabled() { return enabled; },
    toggle() { setEnabled(!enabled); return enabled; },
  };
}
