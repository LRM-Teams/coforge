/**
 * Parses a Raft-style duration literal used by `coforge reminder` flags such as `snooze --by` and
 * `update --in`, and (as a fallback) `schedule`/`snooze --delay-seconds`: an unsigned integer with
 * an optional single-letter unit suffix (`s` seconds, `m` minutes, `h` hours, `d` days). No suffix
 * means seconds, matching the existing bare-integer `--delay-seconds` behavior.
 *
 * Returns `null` — never throws — for anything that is not a positive safe-integer number of
 * seconds: a malformed literal, an unknown suffix, zero, or a result that overflows
 * `Number.MAX_SAFE_INTEGER`. Callers render their own usage error on `null`.
 */
const DURATION_PATTERN = /^(\d+)(s|m|h|d)?$/;
const SECONDS_PER_UNIT: Record<"s" | "m" | "h" | "d", number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

export function parseDurationSeconds(input: string): number | null {
  const match = DURATION_PATTERN.exec(input);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s") as "s" | "m" | "h" | "d";
  const seconds = amount * SECONDS_PER_UNIT[unit];
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  return seconds;
}
