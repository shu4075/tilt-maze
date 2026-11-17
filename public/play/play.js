// スマホ画面：参加、方向ボタン（標準）と傾きセンサー（おまけ）の入力と送信、再接続
import { io } from '/socket.io/socket.io.esm.min.js';

const $ = (id) => document.getElementById(id);
const socket = io();

// サーバから player:joined で届く設定（server/config.js が元）。届くまでの仮の値
const settings = { deadzoneDeg: 12, hysteresisDeg: 3, heartbeatMs: 1000 };

const params = new URLSearchParams(location.search);
let roomCode = (params.get('room') || '').toUpperCase();
let joined = false;   // 一度でも参加に成功したら true（再接続時に自動で入り直す）
let phase = 'lobby';
let input = { x: 0, y: 0 };
let mode = 'touch';   // 'sensor' | 'touch'

// ---------- localStorage（使えない環境でも落ちないように） ----------
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 無視 */ } },
};
const tokenKey = (code) => `tilt-maze:token:${code}`;
const NICKNAME_KEY = 'tilt-maze:nickname';

function showScreen(name) {
  for (const s of ['join', 'control', 'result']) $(`screen-${s}`).hidden = s !== name;
}

// ======================================================================
// 傾きセンサー（DeviceOrientation）
// ======================================================================
const sensor = {
  available: false,   // 実際に値が届いたら true
  permission: 'unknown',
  raw: null,          // 画面の向きに合わせた生の角度 { x, y }
  base: null,         // 「水平」とみなす基準の角度
  dir: { x: 0, y: 0 },
};

/**
 * iPhone（iOS 13 以降）はセンサーを使うのにユーザーの許可が必要で、
 * しかも「ボタンを押した瞬間」の処理の中で requestPermission を呼ばないと拒否される。
 * そのため参加ボタンの submit の最初で、await より前にこの関数を呼ぶ。
 */
function requestSensorPermission() {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) return Promise.resolve('unsupported');
  if (typeof DOE.requestPermission === 'function') {
    return DOE.requestPermission().catch(() => 'denied');
  }
  return Promise.resolve('granted'); // Android などは許可不要
}

/**
 * 画面の向き（縦持ち・横持ち）に合わせて、センサーの角度を「画面の左右・上下」に直す。
 *   gamma：左右の傾き（右に傾けると＋）
 *   beta ：前後の傾き（手前に起こすと＋）
 */
function screenAngles(e) {
  const angle = (screen.orientation?.angle ?? window.orientation ?? 0) % 360;
  const { beta, gamma } = e;
  switch ((angle + 360) % 360) {
    case 90: return { x: beta, y: -gamma };
    case 270: return { x: -beta, y: gamma };
    case 180: return { x: -gamma, y: -beta };
    default: return { x: gamma, y: beta };
  }
}

/**
 * 角度を -1 / 0 / +1 の票にする。
 * デッドゾーン（±12°）の中は 0。手が少し震えたくらいで票が変わらないようにするため。
 * さらに一度 ±1 になったら、少し戻したくらいでは 0 にしない（境目でのチラつき防止）。
 */
function toDir(deg, prev) {
  const on = settings.deadzoneDeg;
  const off = settings.deadzoneDeg - settings.hysteresisDeg;
  if (prev !== 0 && Math.sign(deg) === prev && Math.abs(deg) > off) return prev;
  if (deg > on) return 1;
  if (deg < -on) return -1;
  return 0;
}

function onOrientation(e) {
  if (e.beta == null || e.gamma == null) return;
  sensor.available = true;
  sensor.raw = screenAngles(e);
  // 最初の値を「水平」とする。手に持った自然な角度を基準にできるので、
  // スマホを机に置いたように真っ平らに持たなくてよい
  if (!sensor.base) sensor.base = { ...sensor.raw };
  const dx = sensor.raw.x - sensor.base.x;
  // 手前に起こす（beta が増える）と「下」、奥へ倒すと「上」
  const dy = sensor.raw.y - sensor.base.y;
  sensor.dir = { x: toDir(dx, sensor.dir.x), y: toDir(dy, sensor.dir.y) };
  if (mode === 'sensor') setInput(sensor.dir.x, sensor.dir.y);
}

function startSensor(permission) {
  sensor.permission = permission;
  if (permission !== 'granted') {
    setMode('touch');
    return;
  }
  window.addEventListener('deviceorientation', onOrientation);
  // 許可不要の端末でも、センサーが無い・HTTP で開いているなどで値が来ないことがある。
  // 少し待って値が来ていればセンサー操作、来なければボタン操作のままにする
  setTimeout(() => {
    if (!sensor.available) sensor.permission = 'unsupported';
    setMode(sensor.available ? 'sensor' : 'touch');
  }, 800);
}

function calibrate() {
  if (sensor.raw) sensor.base = { ...sensor.raw };
  sensor.dir = { x: 0, y: 0 };
  if (mode === 'sensor') setInput(0, 0);
}

// ======================================================================
// 操作方法の切り替え
// ======================================================================
function setMode(next) {
  if (next === 'sensor' && !sensor.available) next = 'touch';
  mode = next;
  $('mode-sensor').setAttribute('aria-checked', String(mode === 'sensor'));
  $('mode-touch').setAttribute('aria-checked', String(mode === 'touch'));
  $('pad').dataset.mode = mode;
  $('calibrate').hidden = mode !== 'sensor';
  // 試して使えなかった端末では、おまけモードのボタンを押せなくする
  $('mode-sensor').disabled = ['denied', 'unsupported'].includes(sensor.permission);

  let hint = '押している間だけ、その方向に1票。斜めもOK';
  if (mode === 'sensor') {
    hint = 'スマホを傾けた方向に1票。持ちやすい角度で「今の角度を水平にする」を押してね';
    calibrate();
  } else if (sensor.permission === 'denied') {
    hint = 'センサーが許可されなかったので、ボタンで操作してね';
  } else if (sensor.permission === 'unsupported') {
    hint = window.isSecureContext
      ? 'この端末では傾きセンサーが使えないので、ボタンで操作してね'
      : '傾きセンサーは https:// のページでだけ使えます。ボタンで操作してね';
  }
  $('mode-hint').textContent = hint;
  if (mode === 'touch') setInput(0, 0);
}

// おまけモード：スマホを傾けて操作する。
// iPhone はセンサーを使う前に許可が必要で、「ボタンを押した瞬間」に頼まないと断られる。
// だからこのボタンが押されたときに、はじめて許可を求める
$('mode-sensor').addEventListener('click', () => {
  if (sensor.permission === 'unknown') requestSensorPermission().then(startSensor);
  else setMode('sensor');
});
$('mode-touch').addEventListener('click', () => setMode('touch'));
$('calibrate').addEventListener('click', calibrate);

// ======================================================================
// タッチパッド：押している位置で向きを決める（中央1/3は「なし」、斜めも可）
// ======================================================================
const pad = $('pad');
let activePointer = null;

function padDir(e) {
  const r = pad.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width - 0.5;  // -0.5〜0.5
  const fy = (e.clientY - r.top) / r.height - 0.5;
  const zone = 1 / 6;
  return {
    x: fx > zone ? 1 : fx < -zone ? -1 : 0,
    y: fy > zone ? 1 : fy < -zone ? -1 : 0,
  };
}

pad.addEventListener('pointerdown', (e) => {
  if (mode !== 'touch') return;
  activePointer = e.pointerId;
  // 指がパッドの外へ出ても追い続けるため（失敗しても操作自体はできるので無視）
  try { pad.setPointerCapture(e.pointerId); } catch { /* 無視 */ }
  const d = padDir(e);
  setInput(d.x, d.y);
  e.preventDefault();
});
pad.addEventListener('pointermove', (e) => {
  if (mode !== 'touch' || e.pointerId !== activePointer) return;
  const d = padDir(e);
  setInput(d.x, d.y);
});
const release = (e) => {
  if (e.pointerId !== activePointer) return;
  activePointer = null;
  if (mode === 'touch') setInput(0, 0);
};
pad.addEventListener('pointerup', release);
pad.addEventListener('pointercancel', release);
// iPhone で長押しメニューやスクロールが出ないように
pad.addEventListener('contextmenu', (e) => e.preventDefault());

// ======================================================================
// 入力の送信
// ======================================================================
// 値が変わったときは即送信。加えて1秒ごとに今の値を送り、
// これがサーバへの「まだいるよ」の合図（heartbeat）になる。
function setInput(x, y) {
  if (x === input.x && y === input.y) return;
  input = { x, y };
  drawArrow();
  if (joined) socket.emit('player:input', input);
}

let heartbeatTimer = null;
function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (joined && socket.connected) socket.emit('player:input', input);
  }, settings.heartbeatMs);
}

/** 自分の今の向きを大きな矢印で見せる（なしのときは丸） */
function drawArrow() {
  const svg = $('arrow');
  const none = input.x === 0 && input.y === 0;
  svg.classList.toggle('none', none);
  if (!none) {
    const deg = (Math.atan2(input.y, input.x) * 180) / Math.PI;
    svg.querySelector('.arrow-shape').setAttribute('transform', `rotate(${deg})`);
  }
}

// ======================================================================
// 参加
// ======================================================================
$('room-input').value = roomCode;
$('nickname-input').value = storage.get(NICKNAME_KEY) || '';
if (roomCode && !$('nickname-input').value) $('nickname-input').focus();

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  roomCode = $('room-input').value.trim().toUpperCase();
  const nickname = $('nickname-input').value.trim();
  if (!roomCode || !nickname) return;
  storage.set(NICKNAME_KEY, nickname);
  $('join-error').textContent = '';
  $('join-button').disabled = true;
  sendJoin(nickname);
});

function sendJoin(nickname) {
  // token があれば「同じプレイヤー」として復帰できる
  socket.emit('player:join', {
    roomCode,
    nickname: nickname ?? storage.get(NICKNAME_KEY),
    token: storage.get(tokenKey(roomCode)) || undefined,
  });
}

socket.on('player:joined', ({ token, color, nickname, roomCode: code, settings: s }) => {
  const first = !joined;
  joined = true;
  Object.assign(settings, s);
  storage.set(tokenKey(code), token);
  $('join-button').disabled = false;
  $('me-color').style.background = color;
  $('me-name').textContent = nickname;
  startHeartbeat();
  socket.emit('player:input', input); // すぐ有効人数に入るように
  if (first) {
    if (phase !== 'result') showScreen('control');
    setMode('touch'); // 標準は方向ボタン
    keepScreenOn();
  }
});

socket.on('player:error', ({ message }) => {
  $('join-button').disabled = false;
  $('join-error').textContent = message;
  if (joined) {
    // 再接続したらルームが消えていた場合
    joined = false;
    showScreen('join');
  }
});

socket.on('room:closed', () => {
  joined = false;
  showScreen('join');
  $('join-error').textContent = 'ルームが閉じられました。新しいQRコードから参加してください';
});

// ======================================================================
// ゲームの状態
// ======================================================================
const PHASE_LABEL = {
  lobby: 'スタート待ち',
  countdown: 'まもなく開始',
  playing: 'プレイ中',
  result: 'おわり',
};

let countdownTimer = null;
socket.on('game:phase', (p) => {
  phase = p.phase;
  $('phase-label').textContent = PHASE_LABEL[phase] ?? phase;
  $('phase-label').dataset.phase = phase;
  if (phase !== 'playing') {
    setMajority(null);
    showMajorityDirection(null);
  }

  clearInterval(countdownTimer);
  $('countdown').hidden = true;
  if (phase === 'countdown') {
    let n = Math.ceil((p.countdownMs ?? 3000) / 1000);
    $('countdown').textContent = n;
    $('countdown').hidden = false;
    countdownTimer = setInterval(() => {
      n--;
      if (n > 0) $('countdown').textContent = n;
      else { $('countdown').textContent = 'GO!'; clearInterval(countdownTimer); }
    }, 1000);
  }
  if (joined && phase !== 'result') showScreen('control');
});

/**
 * 今の多数派の方向を、十字ボタンの ▲▼◀▶ に色で出す（緑）。
 * 自分の選んだ方向は中央の大きな矢印（黄色）なので、2つを見比べれば合っているか分かる。
 */
function showMajorityDirection(m) {
  const on = { up: m?.y < 0, down: m?.y > 0, left: m?.x < 0, right: m?.x > 0 };
  for (const dir of Object.keys(on)) {
    document.querySelector(`.pad-label.${dir}`).classList.toggle('major', Boolean(on[dir]));
  }
}

// 全体の向き（1秒に5回）。コンパスと多数派の方向、「いま多数派か」の表示に使う
let wasPilot = false;
socket.on('game:votes', ({ tx, ty, majority, youAreMajority, mode, youArePilot, pilotNickname }) => {
  if (phase !== 'playing') return;
  showMajorityDirection(majority);
  const dot = $('compass-dot');
  // 傾き -1〜1 を、コンパスの円の中の位置に変える
  dot.style.transform = `translate(${tx * 26}px, ${ty * 26}px)`;

  if (mode === 'random-one') {
    // ランダムに1人：自分が操縦者かどうかを大きく知らせる
    if (youArePilot && !wasPilot) navigator.vibrate?.(200);
    wasPilot = youArePilot;
    showPilotStatus(youArePilot, pilotNickname);
  } else {
    // 右と左が同じくらいで床が動いていないときは、多数派がいない
    const split = majority.x === 0 && majority.y === 0;
    setMajority(youAreMajority, true, split);
  }
});

function showPilotStatus(isPilot, nickname) {
  const el = $('majority');
  el.dataset.state = isPilot ? 'pilot' : 'none';
  el.textContent = isPilot ? 'あなたが操縦者！' : `操縦者：${nickname ?? '-'}`;
}

/** v: true = 多数派 / false = 少数派 / null = 集計に入っていない（5秒以上押していない） */
function setMajority(v, playing = false, split = false) {
  wasPilot = false;
  const el = $('majority');
  if (v != null && split) {
    el.dataset.state = 'none';
    el.textContent = '意見が割れてる！';
    return;
  }
  el.dataset.state = v == null ? 'none' : v ? 'major' : 'minor';
  el.textContent = v == null ? (playing ? '押して参加！' : '-') : v ? 'いま多数派' : 'いま少数派';
  if (v == null) $('compass-dot').style.transform = 'translate(0, 0)';
}

socket.on('game:result', ({ cleared, clearTimeMs, yourMajorityRate, award }) => {
  $('res-title').textContent = cleared ? 'クリア！' : '時間切れ';
  $('screen-result').classList.toggle('timeout', !cleared);
  $('res-time').textContent = cleared ? `${(clearTimeMs / 1000).toFixed(2)} 秒` : '';
  $('res-rate').textContent = yourMajorityRate == null ? '-' : `${Math.round(yourMajorityRate * 100)}%`;
  const el = $('res-award');
  el.hidden = !award;
  el.dataset.award = award ?? '';
  el.textContent = award === 'teamPlayer' ? '🏆 チームプレイヤー賞！'
    : award === 'rebel' ? '⚡ 孤高の反逆者賞！' : '';
  showScreen('result');
  setInput(0, 0);
});

// ======================================================================
// 接続・再接続
// ======================================================================
socket.on('connect', () => {
  $('conn-status').hidden = true;
  // 通信が切れて戻ってきたら、保存した token で自動的に入り直す
  if (joined) sendJoin();
});
socket.on('disconnect', () => {
  if (joined) $('conn-status').hidden = false;
});

// 画面が消えると操作できないので、対応している端末では画面を点けたままにする
let wakeLock = null;
async function keepScreenOn() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* 非対応・拒否なら何もしない */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && joined) {
    // 画面を消すと wakeLock は自動で解除されるので取り直す
    if (!wakeLock || wakeLock.released) keepScreenOn();
    // 戻ってきたらすぐ生存確認を送って、有効人数に復帰する
    socket.emit('player:input', input);
  }
});

drawArrow();
