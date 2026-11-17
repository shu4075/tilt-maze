// 迷路の3D表示（Three.js）。
// 物理（physics.js）が計算したボールの位置と、床の傾きを受け取って描くだけ。
// 迷路全体を1つのグループ（board）に入れ、そのグループを回転させて「床が傾く」様子を見せる。
import * as THREE from 'three';
import {
  MAX_TILT_DEG, BALL_RADIUS, WALL_HEIGHT, CONVEYOR_ANIM_SPEED,
  CAMERA_HEIGHT, CAMERA_BACK, CAMERA_FOV,
} from '../../config.js';
import { CONVEYORS, wallRects } from './physics.js';
import { drawStatic, drawChevrons } from './minimap.js';

const TEX_CELL = 64; // 床の模様の細かさ（1マスあたりのピクセル数）

// WebGL の描画担当（renderer）は Canvas ごとに1つだけ作って使い回す。
// ステージを変えるたびに作り直すと、ブラウザの「WebGL は同時に○個まで」の上限に当たるため
const renderers = new WeakMap();

function getRenderer(canvas) {
  let r = renderers.get(canvas);
  if (!r) {
    r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    renderers.set(canvas, r);
  }
  return r;
}

/** Canvas に絵を描いて、3Dの面に貼る模様（テクスチャ）にする */
function canvasTexture(width, height, draw) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  draw(c.getContext('2d'));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8; // 斜めから見たときに模様がぼやけにくくする
  return tex;
}

/** 1ステージぶんの3D表示を作る */
export function createMazeRenderer(canvas, map) {
  const renderer = getRenderer(canvas);
  const scene = new THREE.Scene();
  const { width: W, height: H } = map;

  // ---------- カメラ：斜め上から見下ろす ----------
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 16 / 10, 0.1, 200);

  // ---------- 光 ----------
  scene.add(new THREE.HemisphereLight(0xffffff, 0x4a5670, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-6, 18, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 10, bottom: -10, near: 1, far: 50 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  // ---------- 迷路（board）：これを回転させて床を傾ける ----------
  // 回転の中心を迷路の真ん中にするため、中身（content）を半分ずらして入れる
  const board = new THREE.Group();
  const content = new THREE.Group();
  content.position.set(-W / 2, 0, -H / 2);
  board.add(content);
  scene.add(board);

  // 土台（床の厚み）
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(W, 0.4, H),
    new THREE.MeshStandardMaterial({ color: 0x2f3d55, roughness: 0.8 }),
  );
  base.position.set(W / 2, -0.2 - 0.001, H / 2);
  content.add(base);

  // 床の表面：真上から見た迷路の絵（穴・ゴールなど）を貼る
  const floorTex = canvasTexture(W * TEX_CELL, H * TEX_CELL, (ctx) => {
    drawStatic(ctx, map, TEX_CELL, { walls: false });
  });
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.9 }),
  );
  floor.rotation.x = -Math.PI / 2; // 立っている板を寝かせて床にする
  floor.position.set(W / 2, 0, H / 2);
  floor.receiveShadow = true;
  content.add(floor);

  // 壁：物理（physics.js）と同じ長方形を、同じ位置に箱として置く
  const wallSide = new THREE.MeshStandardMaterial({ color: 0x222d42, roughness: 0.7 });
  const wallTop = new THREE.MeshStandardMaterial({ color: 0x4d6288, roughness: 0.6 });
  // 箱の6面の材質：[右, 左, 上, 下, 手前, 奥]。上の面だけ明るくして形を見やすくする
  const wallMats = [wallSide, wallSide, wallTop, wallSide, wallSide, wallSide];
  for (const r of wallRects(map)) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(r.w, WALL_HEIGHT, r.h), wallMats);
    wall.position.set(r.x + r.w / 2, WALL_HEIGHT / 2, r.y + r.h / 2);
    wall.castShadow = true;
    wall.receiveShadow = true;
    content.add(wall);
  }

  // 動く床：矢印の模様を貼った板を置き、模様をずらし続けて流れて見せる
  const beltTex = canvasTexture(TEX_CELL, TEX_CELL, (ctx) => {
    ctx.translate(TEX_CELL / 2, TEX_CELL / 2);
    drawChevrons(ctx, TEX_CELL, [-0.5, 0, 0.5]);
  });
  beltTex.wrapS = THREE.RepeatWrapping;
  beltTex.repeat.set(2, 1);
  const beltMat = new THREE.MeshBasicMaterial({ map: beltTex, transparent: true });
  const beltGeo = new THREE.PlaneGeometry(1, 1);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dir = CONVEYORS[map.at(x, y)];
      if (!dir) continue;
      const belt = new THREE.Mesh(beltGeo, beltMat);
      // 板を寝かせ（x軸まわり）、矢印が床の向きを指すように面の中で回す（z軸まわり）
      belt.rotation.set(-Math.PI / 2, 0, Math.atan2(-dir.y, dir.x));
      belt.position.set(x + 0.5, 0.01, y + 0.5);
      content.add(belt);
    }
  }

  // ボール：転がっているのが見えるよう、白い帯の模様を付ける
  const ballTex = canvasTexture(128, 64, (ctx) => {
    ctx.fillStyle = '#e03a2a';
    ctx.fillRect(0, 0, 128, 64);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 24, 128, 16);
  });
  const ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_RADIUS, 32, 20),
    new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.35, metalness: 0.1 }),
  );
  ballMesh.castShadow = true;
  content.add(ballMesh);

  // ---------- 画面の大きさに合わせる ----------
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // 画面が縦長・正方形に近いときは、迷路が切れないようカメラを引く
    const fit = Math.max(1, 1.5 / camera.aspect) * Math.max(W / 16, H / 12);
    camera.position.set(0, CAMERA_HEIGHT * fit, CAMERA_BACK * fit);
    camera.lookAt(0, 0, 0.6);
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const maxTilt = THREE.MathUtils.degToRad(MAX_TILT_DEG);
  const last = { x: null, y: null };
  const rollAxis = new THREE.Vector3();

  return {
    /**
     * 1フレーム描く。
     * ball: 物理の状態（位置・高さ・縮み具合）、tiltX / tiltY: 床の傾き（-1〜1）、time: 秒
     */
    draw(ball, tiltX, tiltY, time = 0) {
      // 床を傾ける。右に傾く（tiltX > 0）→ 右側が下がる。手前に傾く（tiltY > 0）→ 手前側が下がる
      board.rotation.z = -tiltX * maxTilt;
      board.rotation.x = tiltY * maxTilt;

      ballMesh.position.set(ball.x, ball.height, ball.y);
      ballMesh.scale.setScalar(Math.max(0.001, ball.scale));
      // 進んだ距離のぶんだけボールを回して、転がっているように見せる
      if (last.x !== null) {
        const dx = ball.x - last.x;
        const dz = ball.y - last.y;
        const dist = Math.hypot(dx, dz);
        if (dist > 1e-5 && dist < 1) { // 1マス以上の移動はスタートへ戻ったときなので回さない
          rollAxis.set(dz, 0, -dx).normalize();
          ballMesh.rotateOnWorldAxis(rollAxis, dist / BALL_RADIUS);
        }
      }
      last.x = ball.x;
      last.y = ball.y;

      beltTex.offset.x = -((time * CONVEYOR_ANIM_SPEED) % 1);
      renderer.render(scene, camera);
    },

    /** ステージを変えるとき、前のステージの部品を片付ける */
    dispose() {
      observer.disconnect();
      scene.traverse((o) => {
        o.geometry?.dispose();
        for (const m of [].concat(o.material ?? [])) {
          m.map?.dispose();
          m.dispose();
        }
      });
    },
  };
}
