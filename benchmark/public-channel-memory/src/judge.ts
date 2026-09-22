import type { JudgeLabel } from "./types";

export const JUDGE_SYSTEM_PROMPT =
  "You are evaluating conversational AI memory recall. Return JSON only with the format requested.";

const JUDGE_TEMPLATE = `Label the generated answer as CORRECT or WRONG.

## Rules

1. **PARTIAL CREDIT**: If the generated answer includes AT LEAST ONE correct item from the gold answer's list, mark CORRECT. Getting 1 out of 2, 2 out of 4, etc. is always acceptable. Only mark WRONG if NONE of the gold answer items appear.

2. **PARAPHRASES COUNT**: Same concept in different words is CORRECT. "Chocolate raspberry tart" = "chocolate cake with raspberries". "Shelter meal service" = "volunteering at a homeless shelter". Emotions and sentiments in the same positive/negative family count as paraphrases: "proud" = "fulfilled" = "accomplished"; "huge success" = "relieved" = "thrilled" (all express positive achievement). Judge semantic meaning, not exact wording.

3. **EXTRA DETAIL IS FINE**: A longer answer that includes the gold answer's key facts plus additional information is CORRECT. Never penalize for being more detailed or specific. If the generated answer adds extra descriptive details beyond the gold answer while still referencing the same core entity or concept, mark CORRECT.

4. **DATE TOLERANCE**: Dates within 14 days of each other are CORRECT. Durations within 50% are CORRECT (e.g., "5 months" matches "six months"; "19 days" matches "two weeks"). Relative dates ("few days before November") match specific dates in the same window. A specific date (e.g., "February 2020") that is consistent with a vague reference (e.g., "a few years ago" relative to 2023) is CORRECT. Converting "last year" to the actual year (e.g., "2022" when conversations are in 2023) is CORRECT.

5. **SEMANTIC OVERLAP**: Judge whether the generated answer addresses the same topic and captures the core idea of the gold answer. Different wording, phrasing, or level of detail should not result in WRONG if the underlying concept matches. For EMOTIONS and FEELINGS questions, answers expressing sentiments in the same valence (positive/negative) about the same event are CORRECT — do not require the exact same emotion word.

6. **SAME REFERENT**: If the generated answer mentions or references the same named entity, character, person, or concept as the gold answer, mark CORRECT — even if the generated answer provides a different physical description or includes additional details. The key question is: does the generated answer identify the same core entity? If yes, it is CORRECT.

7. **FOCUS ON KNOWLEDGE, NOT WORDING**: The goal is to assess whether the system recalled the right fact. Minor differences in specificity, phrasing, or scope should not result in WRONG. Only mark WRONG when the generated answer demonstrates a genuinely different or incorrect understanding.

## ONLY mark WRONG if:
- The generated answer contains ZERO correct items from the gold answer
- The answer addresses a completely different topic

## Question
Question: {question}
Gold answer: {answer}
Generated answer: {response}

Return JSON with "reasoning" (one sentence) and "label" (CORRECT or WRONG). Do NOT include both labels.`;

export function preprocessAnswer(category: number, answer: string): string {
  if (category === 3 && answer.includes(";")) return answer.split(";")[0]!.trim();
  return answer;
}

export function buildJudgePrompt(input: {
  category: number;
  question: string;
  goldAnswer: string;
  response: string;
}): string {
  return JUDGE_TEMPLATE.replace("{question}", input.question)
    .replace("{answer}", preprocessAnswer(input.category, input.goldAnswer))
    .replace("{response}", input.response);
}

export function parseJudgeResult(content: string): { label: JudgeLabel; reason: string } {
  const stripped = content.trim();
  if (!stripped) return { label: "UNJUDGED", reason: "empty judge response" };
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1) return { label: "UNJUDGED", reason: "judge response was not JSON" };
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as {
      label?: unknown;
      reasoning?: unknown;
    };
    const label = String(parsed.label ?? "").trim().toUpperCase();
    const reason = String(parsed.reasoning ?? stripped).trim();
    if (label === "CORRECT" || label === "WRONG") return { label, reason };
  } catch {
    // fall through
  }
  return { label: "UNJUDGED", reason: "judge response missing CORRECT/WRONG label" };
}

export async function gradeReply(input: {
  category: number;
  question: string;
  goldAnswer: string;
  response: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<{ label: JudgeLabel; reason: string }> {
  const prompt = buildJudgePrompt(input);
  const url = new URL("/chat/completions", input.baseUrl.endsWith("/") ? input.baseUrl : `${input.baseUrl}/`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0,
      messages: [
        { role: "system", content: JUDGE_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!response.ok) {
    return { label: "UNJUDGED", reason: `judge http_${response.status}` };
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return parseJudgeResult(payload.choices?.[0]?.message?.content ?? "");
}
