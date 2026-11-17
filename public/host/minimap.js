// 迷路を真上から見た2Dの絵を Canvas に描く。使い道は2つ：
//   1. 3D表示（render.js）の床に貼る模様（穴・ゴール・動く床など）
//   2. ランキング画面の落下ヒートマップ
import { USE_CHECKPOINTS } from '../../config.js';
import { CONVEYORS } from './physics.js';

const COLORS = {
  floor: '#ece6d6',
  floorLine: 'rgba(0,0,0,0.06)',
  wall: '#2f3d55',
  wallTop: '#46597a',
  hole: '#0b0d12',
  checkpoint: '#3aa0ff',
  goal: '#ffcc33',
  start: 'rgba(47,61,85,0.25)',
  belt: '#c9c2b0',
  beltArrow: 'rgba(230,120,30,0.85)',
};

/**
 * 迷路の動かない部分を描く。
 * walls: false にすると壁のマスも床として塗る（3Dでは壁を立体の箱で別に置くため）。
 */
export function drawStatic(ctx, map, cell, { walls = true } = {}) {
  const { width, height } = map;
  ctx.fillStyle = COLORS.floor;
  ctx.fillRect(0, 0, width * cell, height * cell);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = map.at(x, y);
      const px = x * cell;
      const py = y * cell;
      if (ch === '#') {
        if (!walls) continue;
        ctx.fillStyle = COLORS.wall;
        ctx.fillRect(px, py, cell, cell);
        ctx.fillStyle = COLORS.wallTop;
        ctx.fillRect(px + cell * 0.08, py + cell * 0.08, cell * 0.84, cell * 0.76);
        continue;
      }
      if (CONVEYORS[ch]) {
        ctx.fillStyle = COLORS.belt;
        ctx.fillRect(px, py, cell, cell);
      }
      ctx.strokeStyle = COLORS.floorLine;
      ctx.lineWidth = Math.max(1, cell / 32);
      ctx.strokeRect(px + 0.5, py + 0.5, cell - 1, cell - 1);

      const cx = px + cell / 2;
      const cy = py + cell / 2;
      if (ch === 'H') {
        const g = ctx.createRadialGradient(cx, cy, cell * 0.1, cx, cy, cell * 0.46);
        g.addColorStop(0, '#000');
        g.addColorStop(0.75, COLORS.hole);
        g.addColorStop(1, 'rgba(11,13,18,0.35)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.46, 0, Math.PI * 2);
        ctx.fill();
      } else if (ch === 'G') {
        // チェッカーフラッグ風のゴール
        const n = 4;
        const s = cell / n;
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            ctx.fillStyle = (i + j) % 2 ? '#1b1b1b' : COLORS.goal;
            ctx.fillRect(px + i * s, py + j * s, s, s);
          }
        }
      } else if (ch === 'S') {
        ctx.fillStyle = COLORS.start;
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.38, 0, Math.PI * 2);
        ctx.fill();
      } else if (ch === 'C' && USE_CHECKPOINTS) {
        ctx.fillStyle = COLORS.checkpoint;
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** 動く床の矢印（くの字）を、1マスぶん右向きに描く。3D表示の流れる模様にも使う */
export function drawChevrons(ctx, cell, offsets = [-0.5, 0, 0.5]) {
  ctx.strokeStyle = COLORS.beltArrow;
  ctx.lineWidth = cell * 0.09;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const k of offsets) {
    const cx = k * cell;
    ctx.beginPath();
    ctx.moveTo(cx - cell * 0.12, -cell * 0.2);
    ctx.lineTo(cx + cell * 0.08, 0);
    ctx.lineTo(cx - cell * 0.12, cell * 0.2);
    ctx.stroke();
  }
}

function drawConveyorArrows(ctx, map, cell) {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const dir = CONVEYORS[map.at(x, y)];
      if (!dir) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x * cell, y * cell, cell, cell);
      ctx.clip();
      ctx.translate(x * cell + cell / 2, y * cell + cell / 2);
      ctx.rotate(Math.atan2(dir.y, dir.x)); // 1マスを回転させれば、4方向とも同じ描き方で済む
      drawChevrons(ctx, cell);
      ctx.restore();
    }
  }
}

/** 迷路の上に落下回数のヒートマップを重ねて描く（ランキング画面用） */
export function drawHeatmap(canvas, map, cells) {
  const cell = 40;
  canvas.width = map.width * cell;
  canvas.height = map.height * cell;
  const ctx = canvas.getContext('2d');
  drawStatic(ctx, map, cell);
  drawConveyorArrows(ctx, map, cell);

  const max = Math.max(1, ...cells.map((c) => c.count));
  for (const c of cells) {
    // 落ちた回数が多いほど濃い赤。一番多いマスで不透明度 0.85
    const a = 0.2 + 0.65 * (c.count / max);
    ctx.fillStyle = `rgba(230, 40, 40, ${a})`;
    ctx.fillRect(c.x * cell, c.y * cell, cell, cell);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${cell * 0.45}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(c.count), c.x * cell + cell / 2, c.y * cell + cell / 2);
  }
}
