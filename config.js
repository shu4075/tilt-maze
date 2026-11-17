// ============================================================
// ゲームの数値はすべてこのファイル1か所にまとめる。
// サーバ（server/）とメイン画面（public/host/）の両方がここを読むので、
// 発表前の調整はこのファイルだけ触れば済む。
// （ポート番号などPCごとに変わる設定は .env → server/config.js）
// ============================================================

// ---------- 集計（サーバ） ----------
// 票を集計して傾きを送る回数。1秒に10回。
// スマホが100台あっても、サーバからメイン画面へ送るのは「まとめた値」を1秒10回だけなので軽い
export const TICK_HZ = 10;
// スマホへ集計結果（game:votes）を送る間隔。10Hz の 2回に1回 = 1秒に5回
export const VOTES_EVERY_N_TICKS = 2;

// 放置した人：この時間、方向ボタンを押していない人は集計（分母の人数）から外す。
// 見ているだけの人が多いと床がほとんど傾かなくなるのを防ぐため
export const IDLE_TIMEOUT_MS = 5000;

// 接続が切れた人：この時間、生存確認（heartbeat）が届かないスマホは参加人数から外す
export const PLAYER_TIMEOUT_MS = 3000;
// 生存確認の間隔。タイムアウト3秒の1/3にして、1〜2回取りこぼしても外れないようにする
export const HEARTBEAT_MS = 1000;
// 参加人数の変化を調べる間隔
export const PRESENCE_CHECK_MS = 250;

// 制限時間：1ステージ90秒。過ぎたら「時間切れ」で結果画面へ
export const TIME_LIMIT_MS = 90_000;
// 開始前のカウントダウン
export const COUNTDOWN_MS = 3000;

// 傾き方式。メイン画面の待機画面で選ぶ
//   average    : 平均。(右 − 左) / 人数。息が合うほど大きく傾く（標準）
//   majority   : 多数決。多い方向へ常に最大まで傾く
//   random-one : ランダムに1人。選ばれた「操縦者」の向きだけで傾く
export const TILT_MODES = ['average', 'majority', 'random-one'];
export const DEFAULT_TILT_MODE = 'average';
// ランダムに1人：操縦者を交代する間隔
export const PILOT_SWITCH_MS = 5000;

// 多数派の判定で「傾きなし（0）」とみなす幅。
// 票が完全に釣り合うことは少ないので、わずかな偏りは「どちらでもない」として扱う
export const TILT_SIGN_THRESHOLD = 0.1;
// 表彰の対象にする最低の参加時間（すぐ抜けた人が多数派率 100% で表彰されないように）
export const AWARD_MIN_ACTIVE_MS = 10_000;

// ---------- 部屋と参加者（サーバ） ----------
// 1部屋の参加人数の上限（負荷対策）
export const MAX_PLAYERS = 150;
// ニックネームの最大文字数
export const NICKNAME_MAX = 12;
// ルームコードの文字数と使う文字（I・O など見間違えやすい文字は除く）
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
// メイン画面が切断してから部屋を消すまでの猶予。リロードで部屋が消えないようにするため
export const ROOM_GRACE_MS = 60_000;
// プレイヤーの色（スマホとメイン画面で同じ色を使って「自分」を見つけやすくする）
export const PLAYER_COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#9a6324', '#469990', '#808000',
];

// ---------- スマホを傾ける操作（おまけモード） ----------
// 傾きセンサーのデッドゾーン。基準の角度からこれ以上傾けたら ±1 の票になる
export const SENSOR_DEADZONE_DEG = 12;
// 一度 ±1 になったら、この角度ぶん戻すまで 0 にしない（境目でのチラつきを防ぐ）
export const SENSOR_HYSTERESIS_DEG = 3;

// ---------- 床の傾き（メイン画面） ----------
// 最大傾き θmax。全員が同じ方向を選んだときこの角度まで傾く
export const MAX_TILT_DEG = 15;
// 実際の傾きを目標へ近づける割合（1/60秒あたり）。
// サーバの値は1秒10回しか届かないので、そのまま使うと床がガクンと動く。少しずつ追いかけてなめらかにする
export const TILT_SMOOTHING = 0.12;

// ---------- ボールの物理（メイン画面・cannon-es。長さの単位は「マス」） ----------
// 物理は 1/60 秒刻みで計算する（画面が 120Hz でも動きが変わらないように）
export const PHYSICS_STEP = 1 / 60;
// 最大まで傾いたときにボールを横へ引っぱる加速度（マス/秒²）
export const GRAVITY = 10;
// 床へ押しつける下向きの重力（マス/秒²）。大きいほどボールが跳ねにくい
export const GRAVITY_DOWN = 30;
// 空気抵抗のようなブレーキ（0〜1）。1秒で速度がこの割合だけ減る。
// 傾きを戻せばボールがやがて止まるようにするため
export const BALL_DAMPING = 0.6;
// ボールの半径
export const BALL_RADIUS = 0.35;
// 壁にぶつかったときの跳ね返り（0 = 跳ねない、1 = 同じ速さで跳ね返る）
export const BOUNCE = 0.4;
// 速さの上限（マス/秒）。1ステップで壁をすり抜けないようにする
export const MAX_SPEED = 15;
// 壁の高さ（マス）
export const WALL_HEIGHT = 0.5;
// 動く床（ベルトコンベア）がボールを押す加速度（マス/秒²）。
// 傾きの最大（10）の半分にして、「みんなで半分以上そろえれば逆らえる」強さにする
export const CONVEYOR_ACCEL = 5;
// 動く床の矢印が流れる速さ（見た目だけ）
export const CONVEYOR_ANIM_SPEED = 1.2;
// 落とし穴に落ちるアニメーションの長さ
export const FALL_ANIM_MS = 600;
// チェックポイントを使うか。false なら落ちたら必ずスタートに戻る（企画書どおり）。
// true にすると、ステージの C マスを通ったあとはそこから再開できる
export const USE_CHECKPOINTS = false;

// ---------- 3D表示（メイン画面・Three.js） ----------
// カメラの位置：迷路を斜め上から見る。高さと手前への引きを変えると見え方が変わる
export const CAMERA_HEIGHT = 14.5;
export const CAMERA_BACK = 5.5;
export const CAMERA_FOV = 45;

// ---------- 音 ----------
export const SOUND_VOLUME = 0.5;  // 全体の音量（0〜1）
export const BGM_VOLUME = 0.35;   // 効果音に対する BGM の大きさ
export const BGM_TEMPO = 132;     // BGM の速さ（1分あたりの拍数）

// ---------- リプレイ ----------
export const REPLAY_RECORD_EVERY = 2; // 物理2ステップごと（30回/秒）に位置を記録する
export const REPLAY_SPEED = 2;        // 再生の速さ（倍速）

// ---------- その他 ----------
// ゴールしてから結果画面へ移るまで、余韻を見せる時間
export const GOAL_PAUSE_MS = 800;
// メイン画面をリロードしても同じ部屋に戻るため、ルームコードを覚えておくキー
export const ROOM_STORAGE_KEY = 'tilt-maze:host-room';
