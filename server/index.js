// Express + Socket.IO の起動、静的ファイルの配信、REST API、ゲームの進行。
// スマホとホスト画面は直接つながらず、すべてこのサーバを経由する。
import express from 'express';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import {
  PORT, PUBLIC_URL, PRESENCE_CHECK_MS, ROOM_GRACE_MS, PLAYER_TIMEOUT_MS,
  TICK_HZ, VOTES_EVERY_N_TICKS, COUNTDOWN_MS, AWARD_MIN_ACTIVE_MS,
  SENSOR_DEADZONE_DEG, SENSOR_HYSTERESIS_DEG, HEARTBEAT_MS,
  TILT_MODES, DEFAULT_TILT_MODE, TIME_LIMIT_MS, IDLE_TIMEOUT_MS,
} from './config.js';
import { RoomManager } from './room.js';
import { tick, choosePilot, tiltSign } from './aggregator.js';
import * as db from './db.js';
import { seedStages } from './seed.js';

const PUBLIC_DIR = path.join(db.ROOT_DIR, 'public');

// ---------- DB の準備（ステージが不正ならここで止まる） ----------
db.openDb();
const stageCount = seedStages();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  // 切断の検知を速くする（既定は約45秒かかる）。
  // 実際の「いなくなった」判定は room.js の 3秒タイムアウトで行う。
  pingInterval: 2000,
  pingTimeout: 3000,
});

const rooms = new RoomManager();

app.get('/', (_req, res) => res.redirect('/host/'));
app.use(express.static(PUBLIC_DIR));
// 数値の設定ファイルは1つだけ。メイン画面のブラウザも同じファイルを読む
app.get('/config.js', (_req, res) => res.sendFile(path.join(db.ROOT_DIR, 'config.js')));
// 3D表示と物理エンジンのライブラリ。外部のCDNに頼らず、npm で入れたものをそのまま配る
// （会場のネットが不安定でも、サーバにさえ届けばメイン画面が動く）
app.use('/vendor/three', express.static(path.join(db.ROOT_DIR, 'node_modules/three/build')));
app.use('/vendor/cannon-es', express.static(path.join(db.ROOT_DIR, 'node_modules/cannon-es/dist')));

// ---------- REST API（ランキング画面など、リアルタイムでなくてよい読み込み） ----------

app.get('/api/stages', (_req, res) => res.json(db.listStages()));

app.get('/api/stages/:id', (req, res) => {
  const stage = db.getStage(req.params.id);
  if (!stage) return res.status(404).json({ error: 'ステージがありません' });
  res.json(stage);
});

app.get('/api/ranking/:stageId', (req, res) => res.json(db.ranking(req.params.stageId)));

app.get('/api/heatmap/:stageId', (req, res) => res.json(db.heatmap(req.params.stageId)));

// ---------- 参加用URLの決め方 ----------

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return 'localhost';
}

/**
 * QRコードに載せるURLの土台を決める。
 * 1. .env の PUBLIC_URL（トンネル公開時はこれを使う）
 * 2. ホスト画面を開いたURL（トンネルのURLで開いた場合など）
 * 3. localhost で開いた場合は、同じWi-Fiのスマホから届くよう LAN の IP に置き換える
 */
function baseUrlFor(socket) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const h = socket.handshake.headers;
  const host = String(h['x-forwarded-host'] || h.host || `localhost:${PORT}`);
  const proto = String(h['x-forwarded-proto'] || 'http').split(',')[0];
  const hostname = host.replace(/:\d+$/, '');
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    return `http://${lanAddress()}:${PORT}`;
  }
  return `${proto}://${host}`;
}

const hostChannel = (code) => `host:${code}`;
const playersChannel = (code) => `players:${code}`;

// ---------- 状態の送信 ----------

function phasePayload(room) {
  return {
    phase: room.phase,
    stageId: room.stage?.id ?? null,
    stageName: room.stage?.name ?? null,
    tiltMode: room.tiltMode,
    countdownMs: COUNTDOWN_MS,
    timeLimitMs: TIME_LIMIT_MS,
    // ホスト画面をリロードしたときに経過時間の表示を合わせるため
    elapsedMs: room.phase === 'playing' ? Date.now() - room.startedAt : 0,
  };
}

function emitPhase(room) {
  const payload = phasePayload(room);
  io.to(hostChannel(room.code)).emit('game:phase', payload);
  io.to(playersChannel(room.code)).emit('game:phase', payload);
}

async function sendRoomCreated(socket, room) {
  const joinUrl = `${baseUrlFor(socket)}/play/?room=${room.code}`;
  const qrDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, width: 512 });
  socket.emit('room:created', { roomCode: room.code, joinUrl, qrDataUrl });
  socket.emit('game:phase', phasePayload(room));
  socket.emit('room:players', room.playersPayload(Date.now()));
  if (room.phase === 'result' && room.lastResult) socket.emit('game:result', room.lastResult.host);
}

/**
 * 有効なプレイヤーの顔ぶれが変わったときだけ、ホストに room:players を送る。
 * 毎回送ると通信が無駄なので、ID の並びを比べて変化を調べる。
 */
function pushPresence(room, now, force = false) {
  const payload = room.playersPayload(now);
  const key = payload.players.map((p) => `${p.id}:${p.nickname}`).join(',');
  if (!force && key === room.lastPresenceKey) return;
  room.lastPresenceKey = key;
  io.to(hostChannel(room.code)).emit('room:players', payload);
}

// ---------- ゲームの進行 ----------

/** スタート → 3秒カウントダウン → プレイ開始 */
function startGame(room, stageId, tiltMode) {
  if (room.phase === 'countdown' || room.phase === 'playing') return;
  const stage = db.getStage(stageId);
  if (!stage) return;
  room.stopTimers();
  room.resetForNewGame();
  room.tiltMode = TILT_MODES.includes(tiltMode) ? tiltMode : DEFAULT_TILT_MODE;
  room.stage = { id: stage.id, name: stage.name, width: stage.width, height: stage.height };
  room.phase = 'countdown';
  emitPhase(room);
  room.timers.countdown = setTimeout(() => beginPlaying(room), COUNTDOWN_MS);
}

function beginPlaying(room) {
  const now = Date.now();
  // クリアタイムはサーバの時計で計る。ホストPCやスマホの時計のずれに左右されないため
  room.startedAt = now;
  room.lastTickAt = now;
  room.sessionId = db.createSession(room.stage.id, room.code, now, room.tiltMode);
  room.phase = 'playing';
  emitPhase(room);
  scheduleTicks(room, now);
  // 制限時間。過ぎたら「時間切れ」で結果画面へ（時間もサーバの時計で計る）
  room.timers.limit = setTimeout(() => finishGame(room, 'timeout'), TIME_LIMIT_MS);
  console.log(`[room ${room.code}] プレイ開始 ${room.stage.id}（session ${room.sessionId}）`);
}

/**
 * 1秒に10回（TICK_HZ）gameTick を呼ぶ。
 * setInterval だと Windows ではタイマーの粒度（約15.6ms）のせいで間隔が少しずつ長くなり、
 * 回数が足りなくなる。そこで「n 回目は開始から n×100ms 後」と目標時刻を決めて
 * 毎回 setTimeout し直す。1回ごとの誤差は出ても、遅れが積み重ならず平均がちょうど10回になる。
 */
function scheduleTicks(room, startAt) {
  const interval = 1000 / TICK_HZ;
  let n = 0;
  const loop = () => {
    gameTick(room);
    n++;
    let next = startAt + n * interval;
    const now = Date.now();
    // 大きく遅れたとき（PCのスリープなど）は、取り戻そうと連打せず今から数え直す
    if (next < now - interval) { n = Math.floor((now - startAt) / interval) + 1; next = startAt + n * interval; }
    room.timers.tick = setTimeout(loop, Math.max(0, next - now));
  };
  room.timers.tick = setTimeout(loop, interval);
}

/** 1秒に10回呼ばれる集計。傾きをメイン画面へ、多数派の方向をスマホへ送る */
function gameTick(room) {
  const now = Date.now();
  // タイマーは遅れることがあるので、決め打ちの 100ms ではなく実際の経過時間を使う
  const dt = now - room.lastTickAt;
  room.lastTickAt = now;

  // 集計に入れるのは「直近5秒以内に方向ボタンを押した人」だけ。
  // 見ているだけの人（放置した人）を分母から外し、押している人たちの意見で床が動くようにする
  const active = room.votingPlayers(now);
  // プレイ中に初めて票を入れた人の記録行を作る（途中参加・途中復帰に対応）
  for (const p of active) {
    if (!p.dbId) p.dbId = db.insertPlayer(room.sessionId, p.nickname, now);
  }

  // ランダムに1人：操縦者を決める（5秒ごと、またはいなくなったら交代）
  let pilot = null;
  if (room.tiltMode === 'random-one') {
    room.pilot = choosePilot(active, room.pilot, now);
    pilot = room.pilot ? room.players.get(room.pilot.id) : null;
  }
  const pilotInfo = pilot
    ? { id: pilot.id, nickname: pilot.nickname, color: pilot.color, untilMs: room.pilot.until - now }
    : null;

  const r = tick(active, dt, room.tiltMode, pilot);
  io.to(hostChannel(room.code)).emit('game:tilt', {
    tx: r.tx, ty: r.ty, votes: r.votes, active: r.active, mode: room.tiltMode, pilot: pilotInfo,
  });

  room.tickCount++;
  if (room.tickCount % VOTES_EVERY_N_TICKS === 0) {
    // 今の多数派の方向（-1 / 0 / +1）。スマホの十字ボタンに色で出す
    const majority = { x: tiltSign(r.tx), y: tiltSign(r.ty) };
    // 放置中の人にも送る（多数派の方向を見て、また押し始められるように）
    for (const p of room.activePlayers(now)) {
      // 「いま多数派か」：自分の向きが多数派の方向に沿っていて、逆らっている軸がなければ多数派。
      //   例）多数派が右のとき → 右・右上は多数派、左・上は少数派
      // 放置中（集計に入っていない人）は null
      const { x, y } = p.input;
      const along = x * majority.x + y * majority.y > 0;
      const against = x * majority.x < 0 || y * majority.y < 0;
      io.to(p.socketId).emit('game:votes', {
        tx: r.tx, ty: r.ty, votes: r.votes, majority,
        youAreMajority: r.scores.has(p.id) ? along && !against : null,
        mode: room.tiltMode,
        youArePilot: pilot?.id === p.id,
        pilotNickname: pilot?.nickname ?? null,
      });
    }
  }
}

/** 多数派率を計算し、チームプレイヤー賞（最高）と孤高の反逆者賞（最低）を決める */
function computeAwards(participants) {
  const eligible = participants
    .filter((p) => p.stats.activeMs >= AWARD_MIN_ACTIVE_MS)
    .map((p) => ({ p, rate: p.stats.majorityMs / p.stats.activeMs }))
    .sort((a, b) => b.rate - a.rate);
  if (eligible.length === 0) return { teamPlayer: null, rebel: null };
  const fmt = ({ p, rate }) => ({ id: p.id, nickname: p.nickname, color: p.color, rate });
  return {
    teamPlayer: fmt(eligible[0]),
    // 1人しかいないときに同じ人が両方の賞をもらわないように
    rebel: eligible.length >= 2 ? fmt(eligible[eligible.length - 1]) : null,
  };
}

/**
 * プレイを終えて記録を書き込む。reason は終わり方：
 *   'goal'    ゴールした → 結果画面（クリア）
 *   'timeout' 制限時間が過ぎた → 結果画面（時間切れ）
 *   'abort'   発表者が中断した → 待機画面へ
 */
function finishGame(room, reason) {
  const cleared = reason === 'goal';
  if (room.phase !== 'playing' && room.phase !== 'countdown') return;
  const wasPlaying = room.phase === 'playing';
  room.stopTimers();
  if (!wasPlaying) {
    // カウントダウン中の中断は記録しない
    room.phase = 'lobby';
    emitPhase(room);
    return;
  }

  const now = Date.now();
  const clearTimeMs = now - room.startedAt;
  const participants = [...room.players.values()].filter((p) => p.dbId);

  db.updatePlayers(participants.map((p) => ({
    dbId: p.dbId, nickname: p.nickname, activeMs: p.stats.activeMs, majorityMs: p.stats.majorityMs,
  })));
  db.endSession({
    id: room.sessionId,
    ended_at: now,
    cleared: cleared ? 1 : 0,
    clear_time_ms: cleared ? clearTimeMs : null,
    falls: room.falls,
    player_count: participants.length,
  });
  console.log(`[room ${room.code}] ${{ goal: 'クリア', timeout: '時間切れ', abort: '中断' }[reason]} session ${room.sessionId}`
    + (cleared ? ` ${(clearTimeMs / 1000).toFixed(2)}秒` : ''));

  if (reason === 'abort') {
    room.phase = 'lobby';
    emitPhase(room);
    return;
  }

  const awards = computeAwards(participants);
  const hostResult = {
    sessionId: room.sessionId,
    stageId: room.stage.id,
    stageName: room.stage.name,
    tiltMode: room.tiltMode,
    cleared,
    clearTimeMs,
    falls: room.falls,
    playerCount: participants.length,
    awards,
    // 順位はクリアしたときだけ（時間切れはランキングに載らない）
    rank: cleared ? db.rankOf(room.stage.id, clearTimeMs) : null,
  };
  const perPlayer = new Map(participants.map((p) => [p.id, {
    cleared,
    clearTimeMs,
    falls: room.falls,
    yourMajorityRate: p.stats.activeMs > 0 ? p.stats.majorityMs / p.stats.activeMs : null,
    award: awards.teamPlayer?.id === p.id ? 'teamPlayer'
      : awards.rebel?.id === p.id ? 'rebel' : null,
  }]));
  room.lastResult = { host: hostResult, perPlayer };

  room.phase = 'result';
  emitPhase(room);
  io.to(hostChannel(room.code)).emit('game:result', hostResult);
  for (const p of room.players.values()) {
    if (!p.connected) continue;
    io.to(p.socketId).emit('game:result', perPlayer.get(p.id) ?? noPlayResult(room.lastResult.host));
  }
}

/** プレイに参加していなかった人（観戦だけ）への結果 */
const noPlayResult = ({ cleared, clearTimeMs }) => ({
  cleared, clearTimeMs, yourMajorityRate: null, award: null,
});

// ---------- Socket.IO ----------

io.on('connection', (socket) => {
  // ----- ホスト -----
  // host:create はデータなしでよい。ホスト画面をリロードしたときだけ
  // { resumeCode } を付けて、前と同じ部屋に戻れるようにしている（QRを撮り直さずに済む）。
  socket.on('host:create', async (data) => {
    let room = data?.resumeCode ? rooms.get(data.resumeCode) : null;
    const hostStillThere = room?.hostSocketId && io.sockets.sockets.has(room.hostSocketId);
    if (!room || hostStillThere) room = rooms.create();

    room.hostSocketId = socket.id;
    room.hostLeftAt = null;
    socket.data = { role: 'host', roomCode: room.code };
    socket.join(hostChannel(room.code));
    console.log(`[room ${room.code}] ホスト接続`);
    await sendRoomCreated(socket, room);
  });

  const hostRoom = () => {
    if (socket.data?.role !== 'host') return null;
    const room = rooms.get(socket.data.roomCode);
    return room?.hostSocketId === socket.id ? room : null;
  };

  socket.on('host:start', (data) => {
    const room = hostRoom();
    if (room) startGame(room, String(data?.stageId ?? ''), data?.tiltMode);
  });

  // 落下・チェックポイント・ゴールの報告。物理はホスト画面で計算しているが、
  // 記録（時刻・落下回数・クリアタイム）はサーバが決めて保存する
  socket.on('host:event', (data) => {
    const room = hostRoom();
    if (!room || room.phase !== 'playing') return;
    const type = data?.type;
    if (!['fall', 'checkpoint', 'goal'].includes(type)) return;
    const x = Math.trunc(Number(data.cellX));
    const y = Math.trunc(Number(data.cellY));
    if (!(x >= 0 && x < room.stage.width && y >= 0 && y < room.stage.height)) return;

    db.insertEvent(room.sessionId, Date.now() - room.startedAt, type, x, y);
    if (type === 'fall') room.falls++;
    if (type === 'goal') finishGame(room, 'goal');
  });

  socket.on('host:reset', () => {
    const room = hostRoom();
    if (!room) return;
    if (room.phase === 'playing' || room.phase === 'countdown') {
      finishGame(room, 'abort'); // 中断として記録して待機画面へ
    } else {
      room.phase = 'lobby';
      room.lastResult = null;
      emitPhase(room);
    }
  });

  // ----- スマホ -----
  socket.on('player:join', (data) => {
    const room = rooms.get(data?.roomCode);
    if (!room) {
      socket.emit('player:error', { message: 'ルームが見つかりません。コードを確かめてください' });
      return;
    }
    const now = Date.now();
    const { player, error, rejoined } = room.join({
      nickname: data?.nickname,
      token: data?.token,
      socketId: socket.id,
      now,
    });
    if (error) {
      socket.emit('player:error', { message: error });
      return;
    }
    socket.data = { role: 'player', roomCode: room.code, playerId: player.id };
    socket.join(playersChannel(room.code));
    socket.emit('player:joined', {
      playerId: player.id,
      token: player.token,
      color: player.color,
      nickname: player.nickname,
      roomCode: room.code,
      // 定数は server/config.js にまとめ、スマホにはここで渡す
      settings: {
        deadzoneDeg: SENSOR_DEADZONE_DEG,
        hysteresisDeg: SENSOR_HYSTERESIS_DEG,
        heartbeatMs: HEARTBEAT_MS,
      },
    });
    socket.emit('game:phase', phasePayload(room));
    if (room.phase === 'result' && room.lastResult) {
      socket.emit('game:result',
        room.lastResult.perPlayer.get(player.id) ?? noPlayResult(room.lastResult.host));
    }
    if (!rejoined) console.log(`[room ${room.code}] 参加: ${player.nickname}`);
    // 人数表示はすぐ更新したいので、定期チェックを待たずに送る
    pushPresence(room, now, true);
  });

  // 入力。値が変わったとき＋1秒ごとの生存確認（heartbeat）として届く
  socket.on('player:input', (data) => {
    const { role, roomCode, playerId } = socket.data ?? {};
    if (role !== 'player') return;
    const room = rooms.get(roomCode);
    const p = room?.players.get(playerId);
    // 古い socket（再接続前）からの入力は無視する
    if (!p || p.socketId !== socket.id) return;
    // 1人1票：届いた値で「今の向き」を上書きするだけなので、連打しても票は増えない
    p.input = { x: clampDir(data?.x), y: clampDir(data?.y) };
    room.touch(playerId, Date.now());
  });

  socket.on('disconnect', () => {
    const { role, roomCode, playerId } = socket.data ?? {};
    const room = rooms.get(roomCode);
    if (!room) return;
    if (role === 'player') {
      // socket が切れた本人だけを切断扱いにする（再接続済みの新しい socket は対象外）
      const p = room.players.get(playerId);
      if (p && p.socketId === socket.id) {
        room.disconnect(playerId);
        pushPresence(room, Date.now(), true);
      }
    } else if (role === 'host' && room.hostSocketId === socket.id) {
      room.hostLeftAt = Date.now();
      console.log(`[room ${room.code}] ホスト切断（${ROOM_GRACE_MS / 1000}秒以内に戻れば部屋は残る）`);
    }
  });
});

/** -1 / 0 / 1 以外の値が来ても安全な値に丸める */
function clampDir(v) {
  const n = Number(v);
  return n > 0 ? 1 : n < 0 ? -1 : 0;
}

// 定期チェック：3秒間音沙汰のないスマホを人数から外す・主のいない部屋を片付ける
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.rooms.values()) {
    if (room.hostLeftAt && now - room.hostLeftAt > ROOM_GRACE_MS) {
      finishGame(room, 'abort');
      io.to(playersChannel(room.code)).emit('room:closed');
      rooms.delete(room.code);
      console.log(`[room ${room.code}] ホストが戻らないため部屋を閉じました`);
      continue;
    }
    pushPresence(room, now);
  }
}, PRESENCE_CHECK_MS);

server.listen(PORT, () => {
  console.log('みんなで傾ける転がし迷路 サーバ起動');
  console.log(`  ホスト画面: http://localhost:${PORT}/host/`);
  console.log(`  スマホ参加: http://${lanAddress()}:${PORT}/play/ （同じWi-Fiの場合）`);
  if (PUBLIC_URL) console.log(`  公開URL   : ${PUBLIC_URL}`);
  console.log(`  ステージ ${stageCount} 個 / 集計 1秒に${TICK_HZ}回 / 放置 ${IDLE_TIMEOUT_MS / 1000}秒で集計から外す / 制限時間 ${TIME_LIMIT_MS / 1000}秒`);
});
