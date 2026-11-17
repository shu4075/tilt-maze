// ルーム・参加者・状態（lobby / countdown / playing / result）の管理。
// 通信（Socket.IO）には直接触らず、データの出し入れだけを担当する。
import { randomUUID } from 'node:crypto';
import {
  PLAYER_TIMEOUT_MS, IDLE_TIMEOUT_MS, MAX_PLAYERS, NICKNAME_MAX,
  ROOM_CODE_LENGTH, ROOM_CODE_CHARS, PLAYER_COLORS,
} from './config.js';

/** プレイごとに 0 に戻す集計値 */
const newStats = () => ({ activeMs: 0, majorityMs: 0 });

export class Room {
  constructor(code) {
    this.code = code;
    this.hostSocketId = null;
    this.hostLeftAt = null; // ホストが切断した時刻（猶予後に部屋を消す）
    /** @type {'lobby'|'countdown'|'playing'|'result'} */
    this.phase = 'lobby';
    /** @type {Map<string, any>} playerId → プレイヤー */
    this.players = new Map();
    this.colorIndex = 0;
    // 前回ホストに送った有効プレイヤーの一覧（変化したときだけ送り直すため）
    this.lastPresenceKey = '';

    // ---- 1回のプレイの状態 ----
    this.stage = null;        // { id, name, width, height }
    this.tiltMode = 'average'; // 傾き方式（average / majority / random-one）
    this.pilot = null;        // ランダムに1人：{ id, until }
    this.sessionId = null;    // DB の sessions.id
    this.startedAt = 0;       // プレイ開始時刻（サーバの時計）
    this.falls = 0;
    this.tickCount = 0;
    this.lastTickAt = 0;
    this.lastResult = null;   // 再接続したスマホに結果をもう一度見せるため
    this.timers = { countdown: null, tick: null, limit: null };
  }

  /**
   * 参加または再参加。token が一致すれば同じプレイヤーとして復帰させる。
   * @returns {{ player?: any, error?: string, rejoined?: boolean }}
   */
  join({ nickname, token, socketId, now }) {
    if (token) {
      const existing = [...this.players.values()].find((p) => p.token === token);
      if (existing) {
        existing.socketId = socketId;
        existing.connected = true;
        existing.lastSeen = now;
        if (nickname) existing.nickname = cleanNickname(nickname) || existing.nickname;
        return { player: existing, rejoined: true };
      }
    }

    const name = cleanNickname(nickname);
    if (!name) return { error: 'ニックネームを入れてください' };
    if (this.activePlayers(now).length >= MAX_PLAYERS) {
      return { error: `満員です（上限 ${MAX_PLAYERS} 人）` };
    }

    const player = {
      id: randomUUID().slice(0, 8),
      token: randomUUID(),
      nickname: name,
      color: PLAYER_COLORS[this.colorIndex++ % PLAYER_COLORS.length],
      socketId,
      connected: true,
      lastSeen: now,
      lastPressAt: 0, // 最後に方向ボタンを押していた時刻（放置の判定に使う）
      joinedAt: now,
      input: { x: 0, y: 0 },
      stats: newStats(),
      dbId: null, // このプレイでの players.id（プレイに加わったときに作る）
    };
    this.players.set(player.id, player);
    return { player };
  }

  /** 入力か生存確認が届いたら呼ぶ */
  touch(playerId, now) {
    const p = this.players.get(playerId);
    if (!p) return p;
    p.lastSeen = now;
    // ボタンを押している間は1秒ごとに同じ値が届くので、押し続けている人は放置にならない
    if (p.input.x !== 0 || p.input.y !== 0) p.lastPressAt = now;
    return p;
  }

  disconnect(playerId) {
    const p = this.players.get(playerId);
    if (p) p.connected = false;
  }

  /**
   * 有効なプレイヤー = 接続中 かつ 直近3秒以内に何か届いた人。
   * スマホのタブを閉じた・スリープした・圏外になった、のどれでも3秒で外れる。
   */
  activePlayers(now) {
    return [...this.players.values()].filter(
      (p) => p.connected && now - p.lastSeen <= PLAYER_TIMEOUT_MS,
    );
  }

  /**
   * 集計に入れるプレイヤー = 接続中 かつ 直近5秒以内に方向ボタンを押した人。
   * 5秒以上なにも押していない人は「放置」とみなして、傾きの計算の分母から外す。
   */
  votingPlayers(now) {
    return this.activePlayers(now).filter((p) => now - p.lastPressAt <= IDLE_TIMEOUT_MS);
  }

  /** ホストに送る参加者一覧 */
  playersPayload(now) {
    const list = this.activePlayers(now)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({ id: p.id, nickname: p.nickname, color: p.color }));
    return { count: list.length, players: list };
  }

  /** 新しいプレイを始める前に、前回の集計値を消す */
  resetForNewGame() {
    this.falls = 0;
    this.tickCount = 0;
    this.lastResult = null;
    this.pilot = null;
    for (const p of this.players.values()) {
      p.stats = newStats();
      p.dbId = null;
    }
  }

  stopTimers() {
    clearTimeout(this.timers.countdown);
    clearTimeout(this.timers.tick);
    clearTimeout(this.timers.limit);
    this.timers = { countdown: null, tick: null, limit: null };
  }
}

function cleanNickname(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, NICKNAME_MAX);
}

export class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  create() {
    let code;
    do {
      code = Array.from({ length: ROOM_CODE_LENGTH }, () =>
        ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)],
      ).join('');
    } while (this.rooms.has(code));
    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code ?? '').trim().toUpperCase());
  }

  delete(code) {
    this.rooms.get(code)?.stopTimers();
    this.rooms.delete(code);
  }
}
