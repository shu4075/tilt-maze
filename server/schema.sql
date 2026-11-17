-- みんなで傾ける転がし迷路 のテーブル定義

-- ステージ（起動時に stages/*.json から投入）
CREATE TABLE IF NOT EXISTS stages (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  tiles_json  TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- 1回のプレイ（スタートで作成、ゴールか中断で更新）
CREATE TABLE IF NOT EXISTS sessions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  stage_id       TEXT NOT NULL REFERENCES stages(id),
  room_code      TEXT NOT NULL,
  started_at     INTEGER NOT NULL,          -- UNIX ミリ秒
  ended_at       INTEGER,
  cleared        INTEGER NOT NULL DEFAULT 0, -- 0/1
  clear_time_ms  INTEGER,
  falls          INTEGER NOT NULL DEFAULT 0,
  player_count   INTEGER NOT NULL DEFAULT 0,
  tilt_mode      TEXT NOT NULL DEFAULT 'average' -- 傾き方式（M7で追加）
);
CREATE INDEX IF NOT EXISTS idx_sessions_ranking ON sessions(stage_id, cleared, clear_time_ms);

-- 参加者（プレイごと。参加時に作成、終了時に更新）
CREATE TABLE IF NOT EXISTS players (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id),
  nickname     TEXT NOT NULL,
  joined_at    INTEGER NOT NULL,
  active_ms    INTEGER NOT NULL DEFAULT 0,
  majority_ms  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_players_session ON players(session_id);

-- 落下・チェックポイント・ゴールのイベントログ
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id),
  t_ms        INTEGER NOT NULL,   -- プレイ開始からの経過ミリ秒
  type        TEXT NOT NULL CHECK (type IN ('fall', 'checkpoint', 'goal')),
  cell_x      INTEGER NOT NULL,
  cell_y      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, type);
