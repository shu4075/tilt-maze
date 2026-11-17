// 疑似プレイヤー（ボット）を大量に接続するテスト用スクリプト。
// スマホを何十台も集めなくても、大人数での集計・負荷・切断を確かめられる。
//
//   node tools/bots.js --room ABCD --count 100 --mode random
//
// オプション
//   --room   ルームコード（必須）
//   --count  ボットの数（既定 10）
//   --mode   random / bias-right / split / flaky / right / left / up / down / neutral
//   --url    サーバのURL（既定 http://localhost:3000）
//   --name   ニックネームの頭につける文字（既定は right / random などの性格名）
import { io } from 'socket.io-client';

// ---------- 引数 ----------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1]]);
    return acc;
  }, []),
);
const ROOM = String(args.room || '').toUpperCase();
const COUNT = Number(args.count) || 10;
const MODE = args.mode || 'random';
const URL = args.url || 'http://localhost:3000';
const HEARTBEAT_MS = 1000;

const FIXED = {
  right: { x: 1, y: 0 }, left: { x: -1, y: 0 },
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, neutral: { x: 0, y: 0 },
};
const MODES = ['random', 'bias-right', 'split', 'flaky', ...Object.keys(FIXED)];

if (!ROOM || !MODES.includes(MODE)) {
  console.log('使い方: node tools/bots.js --room ABCD --count 100 --mode random');
  console.log(`  mode: ${MODES.join(' / ')}`);
  process.exit(1);
}

const rand = (a, b) => a + Math.random() * (b - a);
const randomDir = () => ({
  x: Math.floor(Math.random() * 3) - 1,
  y: Math.floor(Math.random() * 3) - 1,
});

// ---------- 1体のボット ----------
function createBot(i) {
  const bot = {
    name: '',
    token: null,
    input: { x: 0, y: 0 },
    socket: null,
    behavior: MODE,
  };

  // モードごとの「性格」を決める
  if (MODE === 'bias-right') bot.behavior = i < Math.round(COUNT * 0.7) ? 'right' : 'random';
  if (MODE === 'split') bot.behavior = i < COUNT / 2 ? 'right' : 'left';
  if (MODE === 'flaky') bot.behavior = 'random';
  // ニックネームは12文字まで。性格がわかる名前にして、リザルトの表彰で確かめやすくする
  bot.name = `${args.name || bot.behavior}-${String(i + 1).padStart(2, '0')}`.slice(-12);
  if (FIXED[bot.behavior]) bot.input = { ...FIXED[bot.behavior] };

  const send = () => {
    if (bot.socket?.connected && bot.token) bot.socket.emit('player:input', bot.input);
  };

  function connect() {
    const s = io(URL, { transports: ['websocket'], reconnection: false });
    bot.socket = s;
    s.on('connect', () => {
      s.emit('player:join', { roomCode: ROOM, nickname: bot.name, token: bot.token || undefined });
    });
    s.on('player:joined', ({ token }) => {
      const rejoined = bot.token === token;
      bot.token = token;
      stats.joined += rejoined ? 0 : 1;
      if (rejoined) stats.rejoined++;
      send();
    });
    s.on('player:error', ({ message }) => {
      console.error(`${bot.name}: ${message}`);
      process.exit(1);
    });
    s.on('game:votes', (v) => { stats.votes++; stats.lastVotes = v; });
    s.on('room:closed', () => { console.log('ルームが閉じられました'); process.exit(0); });
  }

  // 生存確認（heartbeat）。本物のスマホと同じく1秒ごとに今の向きを送る
  setInterval(send, HEARTBEAT_MS);

  // ランダムな向きに変える（random / bias-right の3割 / flaky）
  if (bot.behavior === 'random') {
    const change = () => {
      bot.input = randomDir();
      send();
      setTimeout(change, rand(1000, 4000));
    };
    setTimeout(change, rand(0, 2000));
  }

  // flaky：ときどき切断し、数秒後に同じ token で戻ってくる
  if (MODE === 'flaky') {
    const flake = () => {
      if (bot.socket?.connected) {
        bot.socket.disconnect();
        stats.drops++;
        setTimeout(() => { connect(); setTimeout(flake, rand(3000, 10000)); }, rand(1000, 6000));
      } else {
        setTimeout(flake, 1000);
      }
    };
    setTimeout(flake, rand(3000, 10000));
  }

  // 一斉に繋ぐとサーバに負荷が集中するので、少しずつずらして接続する
  setTimeout(connect, i * 30);
  return bot;
}

const stats = { joined: 0, rejoined: 0, drops: 0, votes: 0, lastVotes: null };
const bots = Array.from({ length: COUNT }, (_, i) => createBot(i));

const counts = bots.reduce((m, b) => ({ ...m, [b.behavior]: (m[b.behavior] || 0) + 1 }), {});
console.log(`ルーム ${ROOM} に ${COUNT} 体接続します（${URL}, mode=${MODE}）`, counts);
console.log('Ctrl+C で終了');

setInterval(() => {
  const connected = bots.filter((b) => b.socket?.connected).length;
  const v = stats.lastVotes;
  const tilt = v ? ` | 全体 tx=${v.tx.toFixed(2)} ty=${v.ty.toFixed(2)}` : '';
  console.log(`接続中 ${connected}/${COUNT} | 参加 ${stats.joined} | 再参加 ${stats.rejoined}`
    + ` | 切断 ${stats.drops} | game:votes 受信 ${stats.votes}${tilt}`);
}, 3000);

process.on('SIGINT', () => {
  bots.forEach((b) => b.socket?.disconnect());
  process.exit(0);
});
