/**
 * 音の検知（純粋ロジック）。
 *
 * v0 の哲学: 汎用の音分類 ML は使わない。家電は決まった周波数で「ピー」と鳴くので、
 * Goertzel アルゴリズム（特定周波数の振幅だけを O(N) で求める）でビープを検知する。
 * 洗濯機・炊飯器・電子レンジ・インターホン等は周波数プロファイル1行で表せる。
 * 音声データそのものは外に出ない。イベントになるのは「鳴った」という事実だけ。
 */

/** S16LE PCM バッファを -1..1 の Float32Array にする */
export function pcm16ToFloat(buffer: Buffer): Float32Array {
  const samples = new Float32Array(Math.floor(buffer.length / 2));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = buffer.readInt16LE(i * 2) / 32768;
  }
  return samples;
}

/** 二乗平均平方根（音量の目安、0..1） */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < samples.length; i += 1) total += samples[i] * samples[i];
  return Math.sqrt(total / samples.length);
}

/**
 * Goertzel: 指定周波数成分の振幅（フルスケール正弦波で ≈1.0）を返す。
 * FFT を持ち込まずに「この周波数、いま鳴ってる？」だけを O(N) で答える。
 */
export function toneAmplitude(samples: Float32Array, sampleRate: number, freqHz: number): number {
  const n = samples.length;
  if (n === 0) return 0;
  const k = Math.round((n * freqHz) / sampleRate);
  const omega = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.sqrt(Math.max(0, power)) / (n / 2);
}

/** 較正用: 周波数帯を掃引して振幅の大きい順に返す（局所最大のみ） */
export function dominantFrequencies(
  samples: Float32Array,
  sampleRate: number,
  options: { fromHz?: number; toHz?: number; stepHz?: number; top?: number } = {},
): Array<{ freqHz: number; amplitude: number }> {
  const fromHz = options.fromHz ?? 200;
  const toHz = options.toHz ?? 4000;
  const stepHz = options.stepHz ?? 25;
  const top = options.top ?? 5;

  const sweep: Array<{ freqHz: number; amplitude: number }> = [];
  for (let freq = fromHz; freq <= toHz; freq += stepHz) {
    sweep.push({ freqHz: freq, amplitude: toneAmplitude(samples, sampleRate, freq) });
  }
  const peaks = sweep.filter((point, index) => {
    const left = sweep[index - 1]?.amplitude ?? 0;
    const right = sweep[index + 1]?.amplitude ?? 0;
    return point.amplitude >= left && point.amplitude >= right;
  });
  return peaks.sort((a, b) => b.amplitude - a.amplitude).slice(0, top);
}

export interface BeepProfile {
  /** イベント名（field は beep:<name> になる） */
  name: string;
  freqHz: number;
  /** この長さ以上鳴き続けたら発火（ミリ秒） */
  minDurationMs?: number;
  /** 検知に必要な振幅 */
  minAmplitude?: number;
  /** 発火後の不応期（ミリ秒） */
  cooldownMs?: number;
}

export interface BeepPulse {
  name: string;
  freqHz: number;
  amplitude: number;
}

/** 1プロファイル分のビープ検知状態機械 */
export class BeepDetector {
  readonly profile: Required<BeepProfile>;
  private toneStartedAt?: number;
  private lastFiredAt = Number.NEGATIVE_INFINITY;

  constructor(profile: BeepProfile) {
    this.profile = {
      name: profile.name,
      freqHz: profile.freqHz,
      minDurationMs: profile.minDurationMs ?? 300,
      minAmplitude: profile.minAmplitude ?? 0.05,
      cooldownMs: profile.cooldownMs ?? 3_000,
    };
  }

  /** PCM ウィンドウを1つ入れる。発火したときだけパルスを返す */
  push(samples: Float32Array, sampleRate: number, at: number): BeepPulse | undefined {
    const amplitude = toneAmplitude(samples, sampleRate, this.profile.freqHz);
    if (amplitude < this.profile.minAmplitude) {
      this.toneStartedAt = undefined;
      return undefined;
    }
    this.toneStartedAt ??= at;
    const sustained = at - this.toneStartedAt >= this.profile.minDurationMs;
    const rearmed = at - this.lastFiredAt >= this.profile.cooldownMs;
    if (sustained && rearmed) {
      this.lastFiredAt = at;
      return { name: this.profile.name, freqHz: this.profile.freqHz, amplitude };
    }
    return undefined;
  }
}

/** 大きな音（何かが起きた）検知。連発しないよう不応期つき */
export class LoudnessDetector {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private lastFiredAt = Number.NEGATIVE_INFINITY;

  constructor(options: { threshold?: number; cooldownMs?: number } = {}) {
    this.threshold = options.threshold ?? 0.25;
    this.cooldownMs = options.cooldownMs ?? 10_000;
  }

  push(level: number, at: number): { level: number } | undefined {
    if (level < this.threshold) return undefined;
    if (at - this.lastFiredAt < this.cooldownMs) return undefined;
    this.lastFiredAt = at;
    return { level: Math.round(level * 1000) / 1000 };
  }
}

/** 環境変数 "washer=2000:800,doorbell=680" 形式のビーププロファイルを読む */
export function parseBeepProfiles(raw: string | undefined): BeepProfile[] {
  if (!raw) return [];
  const profiles: BeepProfile[] = [];
  for (const entry of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
    const match = /^([a-z0-9-]+)=(\d+)(?::(\d+))?$/i.exec(entry);
    if (!match) throw new Error(`TSUKUMO_BEEPS の形式が不正です: "${entry}"（例: washer=2000:800）`);
    profiles.push({
      name: match[1],
      freqHz: Number(match[2]),
      minDurationMs: match[3] !== undefined ? Number(match[3]) : undefined,
    });
  }
  return profiles;
}
