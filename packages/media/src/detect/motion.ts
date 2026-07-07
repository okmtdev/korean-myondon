/**
 * 動体検知（純粋ロジック）。
 *
 * 入力は ffmpeg が吐く低解像度グレースケールの生フレーム（1画素=1バイト）。
 * 連続フレームの平均絶対差分をスコアにし、ヒステリシス付きの状態機械で
 * motion true/false の遷移だけをイベントにする（映像そのものは外に出ない）。
 */

/** 2フレームの平均絶対差分を 0..1 に正規化して返す */
export function frameDiff(prev: Uint8Array, next: Uint8Array): number {
  if (prev.length !== next.length || prev.length === 0) {
    throw new Error(`frame size mismatch: ${prev.length} vs ${next.length}`);
  }
  let total = 0;
  for (let i = 0; i < prev.length; i += 1) {
    total += Math.abs(prev[i] - next[i]);
  }
  return total / (prev.length * 255);
}

export interface MotionOptions {
  /** これ以上のスコアで「動きあり」に入る */
  enterScore?: number;
  /** これ未満のスコアが holdMs 続いたら「動きなし」に戻る */
  exitScore?: number;
  /** 動きが止まってから false に戻すまでの猶予（ミリ秒） */
  holdMs?: number;
}

export interface MotionTransition {
  to: boolean;
  score: number;
}

export class MotionDetector {
  private readonly enterScore: number;
  private readonly exitScore: number;
  private readonly holdMs: number;
  private previous?: Uint8Array;
  private lastActiveAt = 0;
  active = false;

  constructor(options: MotionOptions = {}) {
    this.enterScore = options.enterScore ?? 0.06;
    this.exitScore = options.exitScore ?? 0.03;
    this.holdMs = options.holdMs ?? 10_000;
  }

  /** フレームを1枚入れる。状態が変わったときだけ遷移を返す */
  push(frame: Uint8Array, at: number): MotionTransition | undefined {
    const score = this.previous ? frameDiff(this.previous, frame) : 0;
    this.previous = Uint8Array.from(frame);

    if (!this.active) {
      if (score >= this.enterScore) {
        this.active = true;
        this.lastActiveAt = at;
        return { to: true, score };
      }
      return undefined;
    }

    if (score >= this.exitScore) {
      this.lastActiveAt = at;
      return undefined;
    }
    if (at - this.lastActiveAt >= this.holdMs) {
      this.active = false;
      return { to: false, score };
    }
    return undefined;
  }
}
