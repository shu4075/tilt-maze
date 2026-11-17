// メイン画面（プロジェクターに映す画面）：画面の切り替えと通信、ゲームループ
import { io } from '/socket.io/socket.io.esm.min.js';
import {
  ROOM_STORAGE_KEY, TILT_SMOOTHING, PHYSICS_STEP, GOAL_PAUSE_MS,
  REPLAY_RECORD_EVERY, REPLAY_SPEED, BALL_RADIUS,
} from '../../config.js';
import { parseStage, createGame } from './physics.js';
import { createMazeRenderer } from './render.js';
import { drawHeatmap } from './minimap.js';
import { createSound } from './sound.js';

const $ = (id) => document.getElementById(id);
const socket = io();
const sound = createSound();

// 傾き方式（M7）。計算はサーバの aggregator.js で行い、ここでは選択と表示だけ
const TILT_MODES = [
  { id: 'average', name: '平均（標準）', short: '平均', desc: '（右の人数 − 左の人数）÷ 押している人数。息が合うほど大きく傾く' },
  { id: 'majority', name: '多数決', short: '多数決', desc: '1票でも多い方向へ、いつも最大まで傾く' },
  { id: 'random-one', name: 'ランダムに1人', short: '1人', desc: '5秒ごとに選ばれる「操縦者」1人の向きだけで傾く' },
];
const modeInfo = (id) => TILT_MODES.find((m) => m.id === id) ?? TILT_MODES[0];

// ---------- 状態 ----------
const state = {
  phase: 'lobby',
  stages: [],             // [{ id, name }]
  selectedStageId: null,
  rankingStageId: null,
  map: null,              // 解析済みのステージ
  renderer: null,         // 3D表示（render.js）
  game: null,             // 物理（physics.js）
  ball: null,             // 物理が持っているボールの状態
  timeLimitMs: 90000,     // 制限時間（サーバから届く）
  falls: 0,
  playerCount: 0,
  // 床の傾き：target はサーバから届く目標、tilt は実際に描いている値
  target: { x: 0, y: 0 },
  tilt: { x: 0, y: 0 },
  keys: new Set(),        // 押されている矢印キー（デバッグ用）
  playStartedAt: 0,       // 表示用の経過時間の基準（公式のタイムはサーバが計る）
  lastResult: null,
  lastSessionId: null,
  tiltMode: 'average',    // ロビーで選んでいる傾き方式
  pilotId: null,          // ランダムに1人：今の操縦者
  // リプレイ（M7）：プレイ中のボールの位置を記録し、リザルトから倍速で再生する
  recording: [],          // [x, y, scale, 高さ, tiltX, tiltY, falls] の配列
  stepCount: 0,
  replay: null,           // 再生中なら { frames, t }
};

// sessionStorage はプライベートモード等で使えないことがあるので必ず try で包む
function loadRoomCode() {
  try { return sessionStorage.getItem(ROOM_STORAGE_KEY); } catch { return null; }
}
function saveRoomCode(code) {
  try { sessionStorage.setItem(ROOM_STORAGE_KEY, code); } catch { /* 無視 */ }
}

function showScreen(name) {
  for (const s of ['lobby', 'play', 'result', 'ranking']) {
    $(`screen-${s}`).hidden = s !== name;
  }
}

const fmtTime = (ms) => `${(ms / 1000).toFixed(2)} 秒`;

// ---------- 接続 ----------
// 接続（再接続を含む）のたびに部屋を作る。前の部屋があればそこへ戻る
socket.on('connect', () => {
  $('conn-status').hidden = true;
  socket.emit('host:create', { resumeCode: loadRoomCode() });
});
socket.on('disconnect', () => {
  $('conn-status').hidden = false;
});

socket.on('room:created', ({ roomCode, joinUrl, qrDataUrl }) => {
  saveRoomCode(roomCode);
  $('room-code').textContent = roomCode;
  $('qr').src = qrDataUrl;
  // 画面には「https://」を省いた短い表記を出す（遠くからでも読みやすく）
  $('join-url').textContent = joinUrl.replace(/^https?:\/\//, '');
  console.log('参加URL:', joinUrl);
});

socket.on('room:players', ({ count, players }) => {
  state.playerCount = count;
  $('player-count').textContent = count;
  $('hud-players').textContent = count;
  $('no-players').hidden = count > 0;
  $('player-list').replaceChildren(
    ...players.map((p) => {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = p.color;
      li.append(dot, document.createTextNode(p.nickname));
      return li;
    }),
  );
});

// ---------- ステージ一覧（ロビーのボタン） ----------
async function loadStages() {
  const res = await fetch('/api/stages');
  state.stages = await res.json();
  state.selectedStageId ??= state.stages[0]?.id ?? null;
  state.rankingStageId ??= state.selectedStageId;
  renderStageButtons($('stage-buttons'), () => state.selectedStageId, (id) => {
    state.selectedStageId = id;
  });
  const showModeDesc = () => { $('mode-desc').textContent = modeInfo(state.tiltMode).desc; };
  renderStageButtons($('mode-buttons'), () => state.tiltMode, (id) => {
    state.tiltMode = id;
    showModeDesc();
  }, TILT_MODES.map((m) => ({ id: m.id, label: m.name })));
  showModeDesc();
}

/** ラジオボタン風の選択肢を並べる（ステージ・傾き方式で共用） */
function renderStageButtons(container, getSelected, onSelect, items = null) {
  const list = items ?? state.stages.map((s, i) => ({ id: s.id, label: `${i + 1}. ${s.name}` }));
  const draw = () => {
    container.replaceChildren(...list.map((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'stage-btn';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(it.id === getSelected()));
      b.textContent = it.label;
      b.addEventListener('click', () => { onSelect(it.id); draw(); });
      return b;
    }));
  };
  draw();
}

// ---------- 画面の状態遷移（サーバが決めた phase に従う） ----------
socket.on('game:phase', async (p) => {
  const prev = state.phase;
  state.phase = p.phase;
  if (p.phase !== 'result') stopReplay(false);
  if (p.phase !== 'playing') {
    sound.stopBgm();
    state.pilotId = null;
    $('pilot-banner').hidden = true;
  }

  if (p.phase === 'lobby') {
    showScreen('lobby');
    return;
  }

  if (p.phase === 'countdown' || (p.phase === 'playing' && !state.map)) {
    await prepareStage(p.stageId, p.tiltMode);
  }
  if (p.timeLimitMs) state.timeLimitMs = p.timeLimitMs;

  if (p.phase === 'countdown') {
    showScreen('play');
    runCountdown(p.countdownMs);
  } else if (p.phase === 'playing') {
    showScreen('play');
    $('countdown').hidden = true;
    // 表示用のタイマー。ホスト画面をリロードした場合はサーバから届いた経過時間に合わせる
    state.playStartedAt = performance.now() - (p.elapsedMs || 0);
    if (prev !== 'countdown') showToast('再開');
    sound.startBgm();
  } else if (p.phase === 'result') {
    // ゴール（または時間切れ）の瞬間を少し見せてから結果画面へ（表示内容は game:result で届く）
    setTimeout(() => {
      if (state.phase === 'result') showScreen('result');
    }, prev === 'playing' ? GOAL_PAUSE_MS : 0);
  }
});

async function prepareStage(stageId, tiltMode) {
  const res = await fetch(`/api/stages/${encodeURIComponent(stageId)}`);
  const stage = await res.json();
  state.map = parseStage(stage);
  state.renderer?.dispose(); // 前のステージの3D部品を片付ける
  state.renderer = createMazeRenderer($('maze'), state.map);
  state.game = createGame(state.map);
  state.ball = state.game.ball;
  state.falls = 0;
  state.target = { x: 0, y: 0 };
  state.tilt = { x: 0, y: 0 };
  state.recording = [];
  state.stepCount = 0;
  $('hud-stage').textContent = `${stage.name}・${modeInfo(tiltMode).short}`;
  $('hud-falls').textContent = '0';
  showRemaining(state.timeLimitMs);
  setVotes({ up: 0, down: 0, left: 0, right: 0 }, 0);
}

let countdownTimer = null;
function runCountdown(ms) {
  clearInterval(countdownTimer);
  const el = $('countdown');
  el.hidden = false;
  let n = Math.ceil(ms / 1000);
  const show = (text) => {
    el.textContent = text;
    el.classList.remove('pulse');
    void el.offsetWidth; // アニメーションをやり直すため
    el.classList.add('pulse');
  };
  show(n);
  sound.play('count');
  countdownTimer = setInterval(() => {
    n--;
    if (n > 0) { show(n); sound.play('count'); } else {
      show('GO!');
      sound.play('go');
      clearInterval(countdownTimer);
    }
  }, 1000);
}

let toastTimer = null;
function showToast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1200);
}

// ---------- 傾き（サーバから1秒に10回） ----------
const debugStats = { lastTiltAt: 0, intervals: [], active: 0, frames: 0, fps: 0, fpsAt: 0 };

socket.on('game:tilt', ({ tx, ty, votes, active, pilot }) => {
  state.target = { x: tx, y: ty };
  setVotes(votes, active);
  showPilot(pilot);
  const now = performance.now();
  if (debugStats.lastTiltAt) debugStats.intervals.push(now - debugStats.lastTiltAt);
  if (debugStats.intervals.length > 40) debugStats.intervals.shift();
  debugStats.lastTiltAt = now;
  debugStats.active = active;
});

/** ランダムに1人：今の操縦者と、交代までの残り秒数を出す */
function showPilot(pilot) {
  const el = $('pilot-banner');
  if (!pilot || state.phase !== 'playing') {
    el.hidden = true;
    return;
  }
  if (pilot.id !== state.pilotId) {
    state.pilotId = pilot.id;
    sound.play('pilot');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = '操縦者';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = pilot.color;
    const time = document.createElement('span');
    time.className = 'time';
    el.replaceChildren(label, dot, document.createTextNode(pilot.nickname), time);
  }
  el.querySelector('.time').textContent = `あと ${Math.ceil(pilot.untilMs / 1000)} 秒`;
  el.hidden = false;
}

/** 残り時間の表示。10秒を切ったら赤くする */
function showRemaining(ms) {
  const el = $('hud-time');
  el.textContent = (Math.max(0, ms) / 1000).toFixed(1);
  el.classList.toggle('hurry', ms < 10000);
}

/** 上下左右のメーター：人数と、押している人数に対する割合のバー */
function setVotes(votes, active) {
  for (const dir of ['up', 'down', 'left', 'right']) {
    $(`m-${dir}`).textContent = votes[dir];
    const pct = active ? (votes[dir] / active) * 100 : 0;
    const bar = $(`mb-${dir}`);
    if (dir === 'up' || dir === 'down') bar.style.width = `${pct}%`;
    else bar.style.height = `${pct}%`;
  }
}

// ---------- 矢印キー（デバッグ用：スマホなしで傾ける） ----------
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

window.addEventListener('keydown', (e) => {
  if (ARROWS[e.key]) {
    state.keys.add(e.key);
    e.preventDefault();
  } else if (e.key === 'd' || e.key === 'D') {
    $('debug').hidden = !$('debug').hidden;
  } else if (e.key === 'm' || e.key === 'M') {
    toggleSound();
  }
});
window.addEventListener('keyup', (e) => state.keys.delete(e.key));
window.addEventListener('blur', () => state.keys.clear());

/** 今の目標の傾き。矢印キーが押されていればそちらを優先する */
function currentTarget() {
  if (state.keys.size === 0) return state.target;
  let x = 0;
  let y = 0;
  for (const k of state.keys) {
    x += ARROWS[k][0];
    y += ARROWS[k][1];
  }
  return { x: Math.sign(x), y: Math.sign(y) };
}

// ---------- ゲームループ（60fps） ----------
let lastFrame = performance.now();
let acc = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const elapsed = Math.min(0.1, (now - lastFrame) / 1000); // タブ復帰時に一気に進めない
  lastFrame = now;

  debugStats.frames++;
  if (now - debugStats.fpsAt >= 1000) {
    debugStats.fps = debugStats.frames;
    debugStats.frames = 0;
    debugStats.fpsAt = now;
    updateDebug();
  }

  if (!state.map || $('screen-play').hidden) return;

  if (state.replay) {
    replayFrame(elapsed, now);
    return;
  }

  const playing = state.phase === 'playing';
  // 物理は 1/60 秒の固定刻みで進める（画面のフレームレートに左右されないように）
  acc += elapsed;
  while (acc >= PHYSICS_STEP) {
    acc -= PHYSICS_STEP;
    // 目標の傾きへ少しずつ近づける。1秒に10回しか届かない値をなめらかにつなぐため
    const t = playing ? currentTarget() : { x: 0, y: 0 };
    state.tilt.x += (t.x - state.tilt.x) * TILT_SMOOTHING;
    state.tilt.y += (t.y - state.tilt.y) * TILT_SMOOTHING;
    if (playing) {
      for (const ev of state.game.step(state.tilt.x, state.tilt.y)) handleEvent(ev);
      recordFrame();
    }
  }

  state.renderer.draw(state.ball, state.tilt.x, state.tilt.y, now / 1000);
  if (playing) showRemaining(state.timeLimitMs - (now - state.playStartedAt));
}

/** 物理で起きた出来事をサーバに報告する（記録はサーバが保存する） */
function handleEvent(ev) {
  socket.emit('host:event', ev);
  if (ev.type === 'fall') {
    state.falls++;
    $('hud-falls').textContent = state.falls;
    showToast('落ちた！');
    sound.play('fall');
  } else if (ev.type === 'checkpoint') {
    showToast('チェックポイント');
    sound.play('checkpoint');
  } else if (ev.type === 'goal') {
    showToast('ゴール！');
    sound.stopBgm();
    sound.play('goal');
  }
}

// ---------- リプレイ（M7） ----------
// サーバへは送らず、ホスト画面のメモリにだけ残す（直前の1回ぶん）。
// 物理を再計算するのではなく「位置の記録」を再生するので、必ず同じ動きになる。

/** プレイ中、物理2ステップごと（30回/秒）にボールと床の状態を記録する */
function recordFrame() {
  state.stepCount++;
  if (state.stepCount % REPLAY_RECORD_EVERY !== 0) return;
  const b = state.ball;
  state.recording.push([
    b.x, b.y, b.scale, b.height, state.tilt.x, state.tilt.y, state.falls,
  ]);
}

const RECORD_HZ = 1 / (PHYSICS_STEP * REPLAY_RECORD_EVERY);

function startReplay() {
  if (!state.map || state.recording.length === 0) return;
  state.replay = {
    frames: state.recording, t: 0, ball: { x: 0, y: 0, scale: 1, height: BALL_RADIUS },
  };
  $('hud-time').classList.remove('hurry');
  $('replay-badge').hidden = false;
  $('abort-button').textContent = 'リプレイを終わる';
  showScreen('play');
}

/** goToResult：再生が最後まで行ったらリザルト画面へ戻す */
function stopReplay(goToResult = true) {
  if (!state.replay) return;
  state.replay = null;
  $('replay-badge').hidden = true;
  $('abort-button').textContent = '中断してロビーへ';
  if (goToResult && state.phase === 'result') showScreen('result');
}

function replayFrame(elapsed, now) {
  const r = state.replay;
  r.t += elapsed * REPLAY_SPEED;
  const i = Math.floor(r.t * RECORD_HZ);
  if (i >= r.frames.length) {
    stopReplay(true);
    return;
  }
  const [x, y, scale, height, tx, ty, falls] = r.frames[i];
  Object.assign(r.ball, { x, y, scale, height });
  state.renderer.draw(r.ball, tx, ty, now / 1000);
  $('hud-time').textContent = (i / RECORD_HZ).toFixed(1);
  $('hud-falls').textContent = falls;
}

function toggleSound() {
  const on = sound.toggle();
  $('sound-button').textContent = on ? '♪ ON' : '♪ OFF';
  $('sound-button').setAttribute('aria-pressed', String(on));
}

function updateDebug() {
  const el = $('debug');
  if (el.hidden) return;
  const iv = debugStats.intervals;
  const avg = iv.length ? iv.reduce((a, b) => a + b, 0) / iv.length : 0;
  const max = iv.length ? Math.max(...iv) : 0;
  el.textContent = [
    `fps          ${debugStats.fps}`,
    `game:tilt    平均 ${avg.toFixed(1)} ms / 最大 ${max.toFixed(0)} ms` +
      (avg ? `（${(1000 / avg).toFixed(1)} Hz）` : ''),
    `押している人 ${debugStats.active}`,
    `目標傾き     tx=${state.target.x.toFixed(2)} ty=${state.target.y.toFixed(2)}`,
    `実際の傾き   x=${state.tilt.x.toFixed(2)} y=${state.tilt.y.toFixed(2)}`,
    `phase        ${state.phase}`,
    `矢印キー     ${state.keys.size ? [...state.keys].join(' ') : '-'}`,
  ].join('\n');
}

requestAnimationFrame(frame);

// ---------- リザルト ----------
socket.on('game:result', (r) => {
  state.lastResult = r;
  state.lastSessionId = r.sessionId;
  $('r-stage').textContent = `${r.stageName}・${modeInfo(r.tiltMode).name}`;
  $('r-replay').disabled = state.recording.length === 0;
  // クリアと時間切れで見出しを変える
  $('r-title').textContent = r.cleared ? 'CLEAR!' : 'TIME UP';
  $('screen-result').classList.toggle('timeout', !r.cleared);
  $('r-time').textContent = r.cleared ? fmtTime(r.clearTimeMs) : '時間切れ';
  $('r-rank').textContent = r.cleared ? `${r.rank} 位` : '-';
  if (!r.cleared) { sound.stopBgm(); sound.play('timeout'); }
  // 「次のステージ」は、次があるときだけ押せる
  $('r-next').disabled = !nextStageId(r.stageId);
  $('r-falls').textContent = `${r.falls} 回`;
  $('r-players').textContent = `${r.playerCount} 人`;
  renderAward($('r-team'), r.awards.teamPlayer);
  renderAward($('r-rebel'), r.awards.rebel);
});

function renderAward(el, a) {
  if (!a) {
    el.textContent = '該当なし';
    return;
  }
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = a.color;
  const rate = document.createElement('small');
  rate.textContent = `多数派率 ${Math.round(a.rate * 100)}%`;
  el.replaceChildren(dot, document.createTextNode(a.nickname), rate);
}

/** 一覧で次に並んでいるステージ（最後のステージなら null） */
function nextStageId(stageId) {
  const i = state.stages.findIndex((s) => s.id === stageId);
  return state.stages[i + 1]?.id ?? null;
}

// ---------- ランキング ----------
async function showRanking(stageId) {
  state.rankingStageId = stageId ?? state.rankingStageId ?? state.selectedStageId;
  showScreen('ranking');
  renderStageButtons($('ranking-stages'), () => state.rankingStageId, (id) => {
    state.rankingStageId = id;
    loadRanking();
  });
  await loadRanking();
}

async function loadRanking() {
  const id = encodeURIComponent(state.rankingStageId);
  const [rows, cells, stage] = await Promise.all([
    fetch(`/api/ranking/${id}`).then((r) => r.json()),
    fetch(`/api/heatmap/${id}`).then((r) => r.json()),
    fetch(`/api/stages/${id}`).then((r) => r.json()),
  ]);

  $('ranking-empty').hidden = rows.length > 0;
  $('ranking-rows').replaceChildren(...rows.map((r, i) => {
    const tr = document.createElement('tr');
    if (r.sessionId === state.lastSessionId) tr.className = 'highlight';
    const date = new Date(r.endedAt);
    const cells = [
      i + 1,
      fmtTime(r.clearTimeMs),
      `${r.playerCount}人`,
      `${r.falls}回`,
      modeInfo(r.tiltMode).short,
      `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
    ];
    tr.append(...cells.map((c) => {
      const td = document.createElement('td');
      td.textContent = c;
      return td;
    }));
    return tr;
  }));

  const total = cells.reduce((a, c) => a + c.count, 0);
  $('heatmap-total').textContent = `（合計 ${total} 回）`;
  drawHeatmap($('heatmap'), parseStage(stage), cells);
}

// ---------- ボタン ----------
$('start-button').addEventListener('click', () => {
  if (state.selectedStageId) {
    socket.emit('host:start', { stageId: state.selectedStageId, tiltMode: state.tiltMode });
  }
});
$('ranking-button').addEventListener('click', () => showRanking(state.selectedStageId));
$('ranking-back').addEventListener('click', () => {
  showScreen(state.phase === 'result' ? 'result' : 'lobby');
});
$('abort-button').addEventListener('click', () => {
  if (state.replay) stopReplay(true);
  else socket.emit('host:reset');
});
$('r-replay').addEventListener('click', startReplay);
$('sound-button').addEventListener('click', (e) => {
  toggleSound();
  e.currentTarget.blur(); // スペースキーなどで誤って押し直さないように
});
$('r-lobby').addEventListener('click', () => socket.emit('host:reset'));
$('r-ranking').addEventListener('click', () => showRanking(state.lastResult?.stageId));
$('r-again').addEventListener('click', () => {
  const id = state.lastResult?.stageId ?? state.selectedStageId;
  socket.emit('host:start', { stageId: id, tiltMode: state.lastResult?.tiltMode ?? state.tiltMode });
});
$('r-next').addEventListener('click', () => {
  const id = nextStageId(state.lastResult?.stageId);
  if (!id) return;
  state.selectedStageId = id;
  socket.emit('host:start', { stageId: id, tiltMode: state.lastResult?.tiltMode ?? state.tiltMode });
});
$('sound-button').textContent = sound.enabled ? '♪ ON' : '♪ OFF';
$('sound-button').setAttribute('aria-pressed', String(sound.enabled));

// デバッグ用：ブラウザのコンソールから状態を見られるようにする
window.tiltMaze = { state, socket };
loadStages();
