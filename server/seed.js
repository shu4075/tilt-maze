// stages/*.json を検証して stages テーブルへ投入する。
// サーバ起動時に自動で呼ばれる。単体でも実行でき、ステージを作ったときの確認に使える：
//   node server/seed.js
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT_DIR, openDb, upsertStage } from './db.js';

const STAGES_DIR = path.join(ROOT_DIR, 'stages');
// < > ^ v は動く床（ベルトコンベア）。その向きにボールを押し流す（M7）
const ALLOWED = new Set(['#', '.', 'S', 'G', 'H', 'C', '<', '>', '^', 'v']);

/**
 * ステージの検証。不正なら Error を投げる。
 * 発表中に「ゴールに行けない迷路」を出してしまう事故を、起動時に防ぐため。
 */
export function validateStage(stage, file = stage?.id) {
  const fail = (msg) => { throw new Error(`[${file}] ${msg}`); };
  if (!stage || typeof stage.id !== 'string' || !stage.id) fail('id がありません');
  if (typeof stage.name !== 'string' || !stage.name) fail('name がありません');
  const tiles = stage.tiles;
  if (!Array.isArray(tiles) || tiles.length === 0) fail('tiles がありません');

  // 全行が同じ長さか
  const width = tiles[0].length;
  tiles.forEach((row, y) => {
    if (typeof row !== 'string' || row.length !== width) {
      fail(`${y + 1}行目の長さが ${row?.length} です（1行目は ${width}）`);
    }
    [...row].forEach((ch, x) => {
      if (!ALLOWED.has(ch)) fail(`(${x}, ${y}) に使えない文字 "${ch}" があります`);
    });
  });
  const height = tiles.length;

  // 外周が壁か（ボールが画面外へ転がり出ないように）
  for (let x = 0; x < width; x++) {
    if (tiles[0][x] !== '#' || tiles[height - 1][x] !== '#') fail('上下の外周が壁ではありません');
  }
  for (let y = 0; y < height; y++) {
    if (tiles[y][0] !== '#' || tiles[y][width - 1] !== '#') fail('左右の外周が壁ではありません');
  }

  // S と G がちょうど1つずつあるか
  const find = (ch) => {
    const found = [];
    tiles.forEach((row, y) => [...row].forEach((c, x) => { if (c === ch) found.push({ x, y }); }));
    return found;
  };
  const starts = find('S');
  const goals = find('G');
  if (starts.length !== 1) fail(`S が ${starts.length} 個あります（1個にしてください）`);
  if (goals.length !== 1) fail(`G が ${goals.length} 個あります（1個にしてください）`);

  // S から G まで床でつながっているか（幅優先探索）。壁と落とし穴は通れないものとする
  const passable = (x, y) => tiles[y]?.[x] !== undefined && tiles[y][x] !== '#' && tiles[y][x] !== 'H';
  const seen = new Set([`${starts[0].x},${starts[0].y}`]);
  const queue = [starts[0]];
  while (queue.length) {
    const { x, y } = queue.shift();
    if (x === goals[0].x && y === goals[0].y) return { width, height };
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;
      if (!seen.has(key) && passable(nx, ny)) {
        seen.add(key);
        queue.push({ x: nx, y: ny });
      }
    }
  }
  fail('S から G まで床でつながっていません');
}

/** stages/ の JSON をすべて検証して DB に入れる。1つでも不正なら起動を止める */
export function seedStages() {
  const files = readdirSync(STAGES_DIR).filter((f) => f.endsWith('.json')).sort();
  files.forEach((file, i) => {
    const stage = JSON.parse(readFileSync(path.join(STAGES_DIR, file), 'utf8'));
    validateStage(stage, file);
    upsertStage(stage, i);
  });
  return files.length;
}

// `node server/seed.js` で直接実行されたとき
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  openDb();
  const n = seedStages();
  console.log(`ステージ ${n} 個を検証して投入しました`);
}
