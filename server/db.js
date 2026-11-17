// SQLite 接続とクエリ関数。
// better-sqlite3 は同期APIなので、await なしで順番どおりに読み書きできて扱いやすい。
// DB はファイル1つ（data/tilt-maze.db）なので、発表用PCへのコピーも簡単。
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.join(__dirname, '..');

let db;

export function openDb() {
  const file = path.isAbsolute(DB_PATH) ? DB_PATH : path.join(ROOT_DIR, DB_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  // WAL にすると書き込み中でも読み込み（ランキング表示）が待たされない
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  migrate();
  prepareStatements();
  return db;
}

/**
 * 古いDBファイルに後から増えた列を足す。
 * CREATE TABLE IF NOT EXISTS は既存のテーブルを変えないので、記録を残したまま列だけ追加する。
 */
function migrate() {
  const cols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (!cols.includes('tilt_mode')) {
    db.exec("ALTER TABLE sessions ADD COLUMN tilt_mode TEXT NOT NULL DEFAULT 'average'");
  }
}

let q;
function prepareStatements() {
  q = {
    upsertStage: db.prepare(`
      INSERT INTO stages (id, name, width, height, tiles_json, sort_order)
      VALUES (@id, @name, @width, @height, @tiles_json, @sort_order)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, width = excluded.width, height = excluded.height,
        tiles_json = excluded.tiles_json, sort_order = excluded.sort_order`),
    listStages: db.prepare(
      'SELECT id, name, width, height FROM stages ORDER BY sort_order, id'),
    getStage: db.prepare('SELECT * FROM stages WHERE id = ?'),

    createSession: db.prepare(`
      INSERT INTO sessions (stage_id, room_code, started_at, tilt_mode)
      VALUES (?, ?, ?, ?)`),
    endSession: db.prepare(`
      UPDATE sessions SET ended_at = @ended_at, cleared = @cleared,
        clear_time_ms = @clear_time_ms, falls = @falls, player_count = @player_count
      WHERE id = @id`),

    insertPlayer: db.prepare(
      'INSERT INTO players (session_id, nickname, joined_at) VALUES (?, ?, ?)'),
    updatePlayer: db.prepare(
      'UPDATE players SET active_ms = ?, majority_ms = ?, nickname = ? WHERE id = ?'),

    insertEvent: db.prepare(`
      INSERT INTO events (session_id, t_ms, type, cell_x, cell_y)
      VALUES (?, ?, ?, ?, ?)`),

    // ランキング：クリアした記録をタイムの速い順に10件
    ranking: db.prepare(`
      SELECT id AS sessionId, clear_time_ms AS clearTimeMs, falls,
             player_count AS playerCount, ended_at AS endedAt, tilt_mode AS tiltMode
      FROM sessions
      WHERE stage_id = ? AND cleared = 1
      ORDER BY clear_time_ms ASC, id ASC
      LIMIT 10`),
    // 順位：自分より速い記録の数 + 1
    rankOf: db.prepare(`
      SELECT COUNT(*) + 1 AS rank FROM sessions
      WHERE stage_id = ? AND cleared = 1 AND clear_time_ms < ?`),
    // ヒートマップ：落下イベントをマスごとに数える
    heatmap: db.prepare(`
      SELECT e.cell_x AS x, e.cell_y AS y, COUNT(*) AS count
      FROM events e JOIN sessions s ON s.id = e.session_id
      WHERE s.stage_id = ? AND e.type = 'fall'
      GROUP BY e.cell_x, e.cell_y`),
  };
}

// ---------- ステージ ----------
export function upsertStage(stage, sortOrder) {
  q.upsertStage.run({
    id: stage.id,
    name: stage.name,
    width: stage.tiles[0].length,
    height: stage.tiles.length,
    tiles_json: JSON.stringify(stage.tiles),
    sort_order: sortOrder,
  });
}
export const listStages = () => q.listStages.all();
export function getStage(id) {
  const row = q.getStage.get(id);
  if (!row) return null;
  return {
    id: row.id, name: row.name, width: row.width, height: row.height,
    tiles: JSON.parse(row.tiles_json),
  };
}

// ---------- プレイ記録 ----------
export function createSession(stageId, roomCode, startedAt, tiltMode = 'average') {
  return Number(q.createSession.run(stageId, roomCode, startedAt, tiltMode).lastInsertRowid);
}
export function endSession(s) {
  q.endSession.run(s);
}
export function insertPlayer(sessionId, nickname, joinedAt) {
  return Number(q.insertPlayer.run(sessionId, nickname, joinedAt).lastInsertRowid);
}
/** 終了時に参加者全員の時間をまとめて書き込む（トランザクションで1回のディスク書き込みにする） */
export const updatePlayers = (rows) => db.transaction((list) => {
  for (const r of list) {
    q.updatePlayer.run(Math.round(r.activeMs), Math.round(r.majorityMs), r.nickname, r.dbId);
  }
})(rows);
export function insertEvent(sessionId, tMs, type, x, y) {
  q.insertEvent.run(sessionId, tMs, type, x, y);
}

// ---------- 読み込み ----------
export const ranking = (stageId) => q.ranking.all(stageId);
export const rankOf = (stageId, clearTimeMs) => q.rankOf.get(stageId, clearTimeMs).rank;
export const heatmap = (stageId) => q.heatmap.all(stageId);
