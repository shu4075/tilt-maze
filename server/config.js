// サーバの設定。
// ゲームの数値（集計の回数・制限時間など）は、プロジェクト直下の config.js にまとめてある。
// このファイルには「動かすPCやサービスごとに変わるもの」（.env で変える値）だけを置く。
export * from '../config.js';

// .env があれば読み込む（Node 20.12 以降の標準機能。dotenv 不要）
try {
  process.loadEnvFile();
} catch {
  // .env が無ければ環境変数・既定値をそのまま使う
}

// ポート番号。Render などのクラウドでは、サービス側が PORT を決めて渡してくる
export const PORT = Number(process.env.PORT) || 3000;

// QRコードに載せる公開URL（例: https://xxxx.onrender.com）。
// 空なら、メイン画面を開いたURL → LAN の IP アドレスの順に自動で決める。
export const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

// SQLite のDBファイル
export const DB_PATH = process.env.DB_PATH || 'data/tilt-maze.db';
