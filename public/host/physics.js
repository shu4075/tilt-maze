// ボールの物理。物理エンジン cannon-es で計算する。
//
// なぜ物理をメイン画面で計算するのか：
//   画面は1枚だけなので、そのPCで計算すれば通信の遅れなしに 60fps でなめらかに動く。
//   サーバは「票の集計」と「記録の判定・保存」に集中させる。
//
// 床の傾け方：
//   物理の世界では、床と壁は動かさない。代わりに「重力の向き」を傾ける。
//   床を右に傾けるのと、重力を右下に向けるのは、ボールから見れば同じこと。
//   動かない床のほうが物理エンジンの計算が安定する（壁をすり抜けにくい）ので、この方法にしている。
//   見た目のほうは render.js が迷路全体を回転させて、傾いているように見せる。
//
// 座標：迷路のマス (x, y) を、3Dの (x, 高さ0, z) に対応させる。y（画面の下向き）が 3D の z（手前向き）。
import * as CANNON from 'cannon-es';
import {
  PHYSICS_STEP, GRAVITY, GRAVITY_DOWN, BALL_DAMPING, BALL_RADIUS, BOUNCE, MAX_SPEED,
  WALL_HEIGHT, FALL_ANIM_MS, CONVEYOR_ACCEL, USE_CHECKPOINTS,
} from '../../config.js';

/** 動く床の記号と、押し流す向き */
export const CONVEYORS = {
  '>': { x: 1, y: 0 },
  '<': { x: -1, y: 0 },
  '^': { x: 0, y: -1 },
  v: { x: 0, y: 1 },
};

/** ステージの文字列配列から、壁・穴などを調べやすい形にする */
export function parseStage(stage) {
  const { tiles } = stage;
  let start = null;
  tiles.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === 'S') start = { x, y };
  }));
  return {
    ...stage,
    width: tiles[0].length,
    height: tiles.length,
    start,
    at: (x, y) => tiles[y]?.[x] ?? '#', // 範囲外は壁扱い
  };
}

/**
 * 壁のマスを、できるだけ大きな長方形にまとめる。
 * 1マスずつ箱を置くと、箱と箱の継ぎ目にボールが引っかかることがある。
 * 横に並んだ壁を1本にし、さらに縦に同じ幅で続くものをまとめて、継ぎ目を減らす。
 * @returns {{ x: number, y: number, w: number, h: number }[]}
 */
export function wallRects(map) {
  const rects = [];
  const open = new Map(); // "x,w" → 上の行から続いている長方形
  for (let y = 0; y < map.height; y++) {
    const next = new Map();
    let x = 0;
    while (x < map.width) {
      if (map.at(x, y) !== '#') { x++; continue; }
      let w = 1;
      while (x + w < map.width && map.at(x + w, y) === '#') w++;
      const key = `${x},${w}`;
      const above = open.get(key);
      if (above) {
        above.h++;
        next.set(key, above);
      } else {
        const r = { x, y, w, h: 1 };
        rects.push(r);
        next.set(key, r);
      }
      x += w;
    }
    open.clear();
    for (const [k, r] of next) open.set(k, r);
  }
  return rects;
}

/**
 * 1ステージぶんの物理の世界を作る。
 * 返り値の ball は描画・リプレイ用の状態（迷路の座標）、step() で 1/60 秒進める。
 */
export function createGame(map) {
  const world = new CANNON.World();
  world.gravity.set(0, -GRAVITY_DOWN, 0);

  // 材質の組み合わせごとに、摩擦と跳ね返りを決める
  const ballMat = new CANNON.Material('ball');
  const floorMat = new CANNON.Material('floor');
  const wallMat = new CANNON.Material('wall');
  // 床：摩擦 0・跳ねない。ブレーキは BALL_DAMPING でかけるので、床の摩擦は使わない
  world.addContactMaterial(new CANNON.ContactMaterial(ballMat, floorMat, { friction: 0, restitution: 0 }));
  // 壁：ぶつかると BOUNCE 倍の速さで跳ね返る
  world.addContactMaterial(new CANNON.ContactMaterial(ballMat, wallMat, { friction: 0, restitution: BOUNCE }));

  // 床（厚さ1の大きな箱。上の面が高さ0）
  const floor = new CANNON.Body({ mass: 0, material: floorMat });
  floor.addShape(new CANNON.Box(new CANNON.Vec3(map.width / 2, 0.5, map.height / 2)));
  floor.position.set(map.width / 2, -0.5, map.height / 2);
  world.addBody(floor);

  // 壁（動かない箱）
  for (const r of wallRects(map)) {
    const wall = new CANNON.Body({ mass: 0, material: wallMat });
    wall.addShape(new CANNON.Box(new CANNON.Vec3(r.w / 2, WALL_HEIGHT / 2, r.h / 2)));
    wall.position.set(r.x + r.w / 2, WALL_HEIGHT / 2, r.y + r.h / 2);
    world.addBody(wall);
  }

  // ボール（球）
  const body = new CANNON.Body({
    mass: 1,
    material: ballMat,
    shape: new CANNON.Sphere(BALL_RADIUS),
    linearDamping: BALL_DAMPING,
    angularDamping: 0.5,
  });
  body.allowSleep = false;
  world.addBody(body);

  const ball = {
    x: 0, y: 0,             // 迷路の座標（マス）
    vx: 0, vy: 0,
    height: BALL_RADIUS,    // 床からの高さ（落ちるとき沈む）
    scale: 1,               // 描画用（落ちるとき縮む）
    checkpoint: { ...map.start }, // 落ちたときに戻る場所
    falling: null,          // 落下アニメーション中なら { cellX, cellY, t }
    goaled: false,
  };

  function placeAt(cell) {
    body.position.set(cell.x + 0.5, BALL_RADIUS, cell.y + 0.5);
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    sync();
  }

  /** 物理エンジンの結果を、描画用の状態に写す */
  function sync() {
    ball.x = body.position.x;
    ball.y = body.position.z;
    ball.vx = body.velocity.x;
    ball.vy = body.velocity.z;
    ball.height = body.position.y;
  }

  placeAt(map.start);

  /**
   * 1ステップ（1/60秒）進める。起きた出来事（落下・チェックポイント・ゴール）を配列で返す。
   * tx, ty は今の床の傾き（-1〜1）。
   */
  function step(tx, ty) {
    const events = [];
    const dt = PHYSICS_STEP;
    if (ball.goaled) return events;

    // 落下中：沈みながら縮むアニメーション。終わったらスタート（またはチェックポイント）へ戻す
    if (ball.falling) {
      ball.falling.t += dt * 1000;
      const k = Math.min(1, ball.falling.t / FALL_ANIM_MS);
      ball.scale = 1 - k;
      ball.height = BALL_RADIUS - k * 0.8;
      if (k >= 1) {
        ball.scale = 1;
        ball.falling = null;
        placeAt(ball.checkpoint);
      }
      return events;
    }

    // 床の傾き = 重力の向き。傾き 1 で横向きに GRAVITY の加速度がかかる
    world.gravity.set(tx * GRAVITY, -GRAVITY_DOWN, ty * GRAVITY);

    // 動く床の上なら、床の向きにも押される。傾きと同じ「加速度」として足すので、
    // 逆向きに傾ければ押し返せる
    const belt = CONVEYORS[map.at(Math.floor(ball.x), Math.floor(ball.y))];
    if (belt) {
      body.velocity.x += belt.x * CONVEYOR_ACCEL * dt;
      body.velocity.z += belt.y * CONVEYOR_ACCEL * dt;
    }

    // 速すぎると1ステップで壁を突き抜けるので上限をかける
    const speed = Math.hypot(body.velocity.x, body.velocity.z);
    if (speed > MAX_SPEED) {
      body.velocity.x *= MAX_SPEED / speed;
      body.velocity.z *= MAX_SPEED / speed;
    }

    // ここで物理エンジンが、重力・ブレーキ・壁との衝突をまとめて計算する
    world.step(dt);
    sync();

    // ボールの中心がどのマスにあるかで、穴・チェックポイント・ゴールを判定する
    const cx = Math.floor(ball.x);
    const cy = Math.floor(ball.y);
    const tile = map.at(cx, cy);
    if (tile === 'H') {
      ball.falling = { cellX: cx, cellY: cy, t: 0 };
      // 吸い込まれる感じを出すため、穴の中心へ寄せる
      ball.x = cx + 0.5;
      ball.y = cy + 0.5;
      events.push({ type: 'fall', cellX: cx, cellY: cy });
    } else if (USE_CHECKPOINTS && tile === 'C'
      && (ball.checkpoint.x !== cx || ball.checkpoint.y !== cy)) {
      ball.checkpoint = { x: cx, y: cy };
      events.push({ type: 'checkpoint', cellX: cx, cellY: cy });
    } else if (tile === 'G') {
      ball.goaled = true;
      body.velocity.set(0, 0, 0);
      events.push({ type: 'goal', cellX: cx, cellY: cy });
    }
    return events;
  }

  return { ball, step };
}
