import { createHash } from "node:crypto";
import { HEADLINE_CATEGORIES, type LocomoQuestion, type LocomoSample } from "./types";
import { parseLocomoDateTime, turnBody } from "./locomo-time";

export const LOCOMO10_SHA256 =
  "79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4";

export const DEFAULT_LOCOMO_PATH =
  "/home/zhoujie22/river2_0/evol_bench/LoCoMo/data/locomo/locomo10.json";

type RawTurn = {
  speaker?: unknown;
  text?: unknown;
  blip_caption?: unknown;
  query?: unknown;
};

type RawSample = {
  sample_id?: unknown;
  conversation?: Record<string, unknown>;
  qa?: unknown;
};

function sessionNumber(key: string): number {
  return Number(key.slice("session_".length));
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertLocomoPin(raw: string, expected = LOCOMO10_SHA256): void {
  const actual = sha256Hex(raw);
  if (actual !== expected) {
    throw new Error(`locomo pin mismatch expected=${expected} actual=${actual}`);
  }
}

export async function loadLocomoSample(
  path: string,
  sampleId: string,
  qaLimit: number,
): Promise<LocomoSample> {
  const raw = await Bun.file(path).text();
  assertLocomoPin(raw);
  const parsed = JSON.parse(raw) as RawSample[];
  const row = parsed.find((item) => item.sample_id === sampleId);
  if (!row?.conversation) throw new Error(`locomo sample ${sampleId} not found`);
  const conv = row.conversation;
  const speakerA = String(conv.speaker_a ?? "speaker_a");
  const speakerB = String(conv.speaker_b ?? "speaker_b");
  const sessionKeys = Object.keys(conv)
    .filter((key) => key.startsWith("session_") && !key.endsWith("_date_time"))
    .sort((left, right) => sessionNumber(left) - sessionNumber(right));
  const sessions = sessionKeys.map((key, index) => {
    const number = sessionNumber(key);
    const dateTime = String(conv[`${key}_date_time`] ?? "");
    const turns = (Array.isArray(conv[key]) ? conv[key] : []) as RawTurn[];
    return {
      sessionNumber: number,
      dateTime,
      occurredAt: parseLocomoDateTime(dateTime, index),
      turns: turns.map((turn) => ({
        speaker: String(turn.speaker ?? "unknown"),
        text: String(turn.text ?? ""),
        blipCaption: turn.blip_caption ? String(turn.blip_caption) : undefined,
        query: turn.query ? String(turn.query) : undefined,
      })),
    };
  });
  const qaRows = Array.isArray(row.qa) ? row.qa : [];
  const questions: LocomoQuestion[] = [];
  for (const [index, item] of qaRows.entries()) {
    if (!item || typeof item !== "object") continue;
    const qa = item as Record<string, unknown>;
    const category = Number(qa.category);
    if (!(HEADLINE_CATEGORIES as readonly number[]).includes(category)) continue;
    const answer = qa.answer;
    questions.push({
      sampleId,
      questionIndex: index,
      question: String(qa.question ?? ""),
      answer: answer === undefined || answer === null ? "" : String(answer),
      category,
      questionTime: qa.question_time ? String(qa.question_time) : undefined,
      evidence: Array.isArray(qa.evidence) ? qa.evidence.map((value) => String(value)) : [],
    });
    if (questions.length >= qaLimit) break;
  }
  return { sampleId, speakerA, speakerB, sessions, questions };
}

export function formatTurnLine(speaker: string, turn: LocomoSample["sessions"][number]["turns"][number]) {
  return `${speaker}: ${turnBody(turn)}`;
}
