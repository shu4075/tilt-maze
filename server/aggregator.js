// 1秒に10回の票集計：傾きの計算と多数派率の加算。
//
// なぜサーバで集計するのか：
//   スマホは何十台もあり、それぞれの通信の遅れもバラバラ。全員の票を1か所に集め、
//   同じ時計で数えないと「誰の票がいつ有効か」が決まらない。
//   また有効人数・傾き・多数派率をクライアントに計算させると、改造したスマホで
//   結果を操作できてしまう。だから値はすべてサーバで決めて配る。
import { TILT_SIGN_THRESHOLD, PILOT_SWITCH_MS } from './config.js';

/** 方向ごとの人数を数える */
export function countVotes(activePlayers) {
  const votes = { up: 0, down: 0, left: 0, right: 0, neutral: 0 };
  for (const p of activePlayers) {
    const { x, y } = p.input;
    if (x > 0) votes.right++;
    else if (x < 0) votes.left++;
    if (y > 0) votes.down++;
    else if (y < 0) votes.up++;
    if (x === 0 && y === 0) votes.neutral++;
  }
  return votes;
}

/**
 * 有効なプレイヤーの票から目標の傾きを計算する。方式（mode）は3つ：
 *
 * average（平均・標準）
 *   tx = (右の人数 − 左の人数) / N,   ty = (下の人数 − 上の人数) / N
 *   N は「直近5秒以内に方向ボタンを押した人」の数（5秒以上放置した人は外す）。
 *   右と左が同じ人数なら 0（水平）になり、意見が割れているほど床は傾かない。
 *   全員の息が合ったときだけ ±1（最大傾き θmax）になる。
 *
 * majority（多数決）
 *   多い方の向きに常に最大まで傾ける（同数なら 0）。
 *   1票差でも全力で傾くので、展開が速く、少数派の声は完全に消える。
 *
 * random-one（ランダムに1人）
 *   選ばれた操縦者1人の向きがそのまま傾きになる。他の人の票は表示だけ。
 */
export function computeTilt(activePlayers, mode = 'average', pilot = null) {
  const votes = countVotes(activePlayers);
  const n = activePlayers.length;
  let tx = 0;
  let ty = 0;
  if (mode === 'majority') {
    tx = Math.sign(votes.right - votes.left);
    ty = Math.sign(votes.down - votes.up);
  } else if (mode === 'random-one') {
    tx = pilot?.input.x ?? 0;
    ty = pilot?.input.y ?? 0;
  } else if (n) {
    tx = (votes.right - votes.left) / n;
    ty = (votes.down - votes.up) / n;
  }
  return { tx, ty, votes, active: n };
}

/**
 * ランダムに1人：操縦者を決める。
 * 今の操縦者がいなくなったか、交代の時間（5秒）が来たら、有効な人の中から選び直す。
 * 同じ人が続けて選ばれないよう、2人以上いるときは今の人を除いて選ぶ。
 * @returns {{ id: string, until: number } | null}
 */
export function choosePilot(activePlayers, current, now) {
  const stillHere = current && activePlayers.some((p) => p.id === current.id);
  if (stillHere && now < current.until) return current;
  if (activePlayers.length === 0) return null;
  const pool = activePlayers.length > 1 && current
    ? activePlayers.filter((p) => p.id !== current.id)
    : activePlayers;
  const next = pool[Math.floor(Math.random() * pool.length)];
  return { id: next.id, until: now + PILOT_SWITCH_MS };
}

/** 傾きの値を -1 / 0 / +1 の「向き」にする。小さな偏りは 0 とみなす */
export function tiltSign(t) {
  if (t > TILT_SIGN_THRESHOLD) return 1;
  if (t < -TILT_SIGN_THRESHOLD) return -1;
  return 0;
}

/**
 * 1人の票が全体の向きとどれだけ一致しているか（0, 0.5, 1）。
 * 横と縦を別々に比べ、片方だけ合っていれば 0.5 点。
 * 斜めに傾けている人や、片方の軸だけ迷っている状況も公平に評価できる。
 */
export function majorityScore(input, sx, sy) {
  const mx = Math.sign(input.x) === sx ? 1 : 0;
  const my = Math.sign(input.y) === sy ? 1 : 0;
  return (mx + my) / 2;
}

/**
 * 1回の集計（tick）。傾きを計算し、各プレイヤーの参加時間と
 * 「多数派だった時間」を dt ミリ秒ぶん加算する。
 * 多数派率 = majorityMs / activeMs（時間の重み付き平均）になる。
 */
export function tick(activePlayers, dtMs, mode = 'average', pilot = null) {
  const result = computeTilt(activePlayers, mode, pilot);
  const sx = tiltSign(result.tx);
  const sy = tiltSign(result.ty);
  const scores = new Map();
  for (const p of activePlayers) {
    const score = majorityScore(p.input, sx, sy);
    p.stats.activeMs += dtMs;
    p.stats.majorityMs += dtMs * score;
    scores.set(p.id, score);
  }
  return { ...result, scores };
}
