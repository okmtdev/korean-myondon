/**
 * tsukumo のイベントモデル。
 *
 * すべての観測・変化・ルール発火は TsukumoEvent としてストアに追記される。
 * - snapshot: ポーリングで取得したデバイス状態の全体
 * - change:   前回観測からのフィールド単位の変化（トリガーの入力になる）
 * - rule:     ルールが発火した記録
 */

export type EventKind = "snapshot" | "change" | "rule";

export interface TsukumoEvent {
  /** ISO 8601 (UTC推奨)。ストアの日付分割キーにもなる */
  ts: string;
  /** どのノードで観測したか（例: "home", "remote-camera"） */
  node: string;
  /** イベント源: "switchbot" | "switchbot-webhook" | "kotodama" など */
  source: string;
  /** デバイスID。ルール発火イベントではルールIDが入る */
  deviceId: string;
  deviceName?: string;
  deviceType?: string;
  kind: EventKind;
  /** change のとき: 変化したフィールド名。rule のとき: "fired" */
  field?: string;
  /** change のとき: 変化前の値 */
  from?: unknown;
  /** change のとき: 変化後の値 */
  to?: unknown;
  /** snapshot のとき: 状態全体。rule のとき: 発火の詳細 */
  status?: Record<string, unknown>;
}
