/**
 * 時刻まわりの小道具。
 */

/**
 * "いつ" の指定をパースする。
 * - undefined → fallback
 * - "now" → 現在時刻
 * - "-30m" / "-24h" / "-7d" → 現在からの相対
 * - それ以外 → ISO 8601 として解釈
 */
export function parseWhen(input: string | undefined, fallback?: Date): Date | undefined {
  if (input === undefined || input === "") return fallback;
  if (input === "now") return new Date();
  const relative = /^-(\d+)([mhd])$/.exec(input);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = relative[2] === "m" ? 60_000 : relative[2] === "h" ? 3_600_000 : 86_400_000;
    return new Date(Date.now() - amount * unitMs);
  }
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) {
    throw new Error(`invalid time "${input}" — use ISO 8601, "now", or relative like "-24h" / "-7d"`);
  }
  return new Date(parsed);
}

function minutesOfDay(hhmm: string): number {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) throw new Error(`invalid time of day "${hhmm}" — expected "HH:MM"`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * ローカル時刻での時間帯判定。after="22:00", before="06:00" のような日またぎに対応。
 * 区間は [after, before)。
 */
export function inTimeWindow(now: Date, after?: string, before?: string): boolean {
  if (after === undefined && before === undefined) return true;
  const current = now.getHours() * 60 + now.getMinutes();
  if (after !== undefined && before === undefined) return current >= minutesOfDay(after);
  if (after === undefined && before !== undefined) return current < minutesOfDay(before);
  const start = minutesOfDay(after as string);
  const end = minutesOfDay(before as string);
  if (start <= end) return current >= start && current < end;
  return current >= start || current < end;
}
