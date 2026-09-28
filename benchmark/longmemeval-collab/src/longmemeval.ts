import { createHash } from "node:crypto";
import type { LongMemEvalSample, LongMemEvalSession } from "./types";

export const LONGMEMEVAL_S_SHA256 =
  "08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894";

export const DEFAULT_LONGMEMEVAL_PATH =
  "/home/zhoujie22/river2_0/evol_bench/LongMemEval/data/longmemeval/longmemeval_s.json";

/** "%Y/%m/%d (%a) %H:%M" — the weekday in parentheses is decorative. Naive
 * stamps become UTC instants, the same convention LoCoMo ingest uses. */
const LONGMEMEVAL_TIME_PATTERN = /^(\d{4})\/(\d{2})\/(\d{2})\s+\([A-Za-z]+\)\s+(\d{2}):(\d{2})$/;

export function parseLongMemEvalDateTime(raw: string): Date | null {
  const match = raw.trim().match(LONGMEMEVAL_TIME_PATTERN);
  if (!match) return null;
  const date = new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      0,
    ),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

type RawTurn = { role?: unknown; content?: unknown };

type RawSample = {
  question_id?: unknown;
  question_type?: unknown;
  question?: unknown;
  answer?: unknown;
  question_date?: unknown;
  haystack_dates?: unknown;
  haystack_session_ids?: unknown;
  haystack_sessions?: unknown;
};

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Pins the dataset exactly like the LoCoMo eval pins locomo10.json; pass a
 * different pin when running a different file (longmemeval_m, oracle, ...). */
export function assertLongMemEvalPin(raw: string, expected: string): void {
  const actual = sha256Hex(raw);
  if (actual !== expected) {
    throw new Error(`longmemeval pin mismatch expected=${expected} actual=${actual}`);
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function buildSessions(item: RawSample): LongMemEvalSession[] {
  const haystackSessions = Array.isArray(item.haystack_sessions) ? item.haystack_sessions : [];
  const dates = Array.isArray(item.haystack_dates) ? item.haystack_dates : [];
  const keys = Array.isArray(item.haystack_session_ids) ? item.haystack_session_ids : [];
  const sessions: LongMemEvalSession[] = [];
  for (const [index, rawSession] of haystackSessions.entries()) {
    const turns = Array.isArray(rawSession)
      ? rawSession.map((turn: RawTurn) => ({
          role: turn?.role === "assistant" ? ("assistant" as const) : ("user" as const),
          text: text(turn?.content).trim(),
        }))
      : [];
    if (turns.length === 0) continue;
    const fallback = new Date(Date.UTC(2023, 0, 1, 12, 0, 0) + index * 86_400_000);
    sessions.push({
      sessionIndex: index + 1,
      sessionKey: text(keys[index]) || `session_${index + 1}`,
      occurredAt: parseLongMemEvalDateTime(text(dates[index])) ?? fallback,
      turns,
    });
  }
  return sessions;
}

/** Loads the requested sample indexes (0-based, dataset order). Each
 * LongMemEval sample carries exactly one question. Reads the file once; the
 * optional pin is asserted on that single read. */
export async function loadLongMemEvalSamples(
  path: string,
  indexes: number[],
  pin?: string,
): Promise<LongMemEvalSample[]> {
  const raw = await Bun.file(path).text();
  if (pin) assertLongMemEvalPin(raw, pin);
  const parsed = JSON.parse(raw) as RawSample[];
  const wanted = [...new Set(indexes)].sort((left, right) => left - right);
  const samples: LongMemEvalSample[] = [];
  for (const index of wanted) {
    const item = parsed[index];
    if (!item) throw new Error(`longmemeval sample index ${index} out of range (0-${parsed.length - 1})`);
    const sessions = buildSessions(item);
    if (sessions.length === 0) throw new Error(`longmemeval sample index ${index} has no sessions`);
    samples.push({
      sampleIndex: index,
      sampleId: text(item.question_id) || `sample_${index}`,
      sessions,
      question: {
        sampleId: text(item.question_id) || `sample_${index}`,
        questionIndex: 0,
        questionType: text(item.question_type),
        question: text(item.question),
        answer: text(item.answer),
        questionDate: parseLongMemEvalDateTime(text(item.question_date)),
      },
    });
  }
  return samples;
}
