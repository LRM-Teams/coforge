import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLongMemEvalSamples,
  parseLongMemEvalDateTime,
  sha256Hex,
} from "../src/longmemeval";

const SAMPLE_JSON = JSON.stringify([
  {
    question_id: "lme-a",
    question_type: "single-session-user",
    question: "What degree did I graduate with?",
    answer: "Business Administration",
    question_date: "2023/05/30 (Tue) 23:40",
    haystack_dates: ["2023/05/20 (Sat) 02:21", "2023/05/21 (Sun) 10:00"],
    haystack_session_ids: ["s1", "s2"],
    haystack_sessions: [
      [
        { role: "user", content: "I finally graduated!" },
        { role: "assistant", content: "Congratulations! What degree?" },
        { role: "user", content: "Business Administration." },
      ],
      [
        { role: "user", content: "Any book suggestions?" },
        { role: "assistant", content: "Sure, what genres do you like?" },
      ],
    ],
  },
  {
    question_id: "lme-b",
    question_type: "multi-session",
    question: "How many trips did I take?",
    answer: "2",
    question_date: "2023/06/01 (Thu) 08:00",
    haystack_dates: ["2023/05/01 (Mon) 09:00"],
    haystack_session_ids: ["only"],
    haystack_sessions: [[{ role: "user", content: "Back from my second trip." }]],
  },
]);

async function withDataset(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "lme-test-"));
  const path = join(dir, "longmemeval.json");
  await Bun.write(path, SAMPLE_JSON);
  await run(path);
}

describe("parseLongMemEvalDateTime", () => {
  test("parses the dataset stamp format into a UTC instant", () => {
    const date = parseLongMemEvalDateTime("2023/05/20 (Sat) 02:21");
    expect(date?.toISOString()).toBe("2023-05-20T02:21:00.000Z");
  });

  test("returns null for malformed stamps", () => {
    expect(parseLongMemEvalDateTime("May 20 2023")).toBeNull();
    expect(parseLongMemEvalDateTime("")).toBeNull();
  });
});

describe("loadLongMemEvalSamples", () => {
  test("selects, dedupes, and orders requested indexes", async () => {
    await withDataset(async (path) => {
      const samples = await loadLongMemEvalSamples(path, [1, 0, 1]);
      expect(samples.map((sample) => sample.sampleId)).toEqual(["lme-a", "lme-b"]);
    });
  });

  test("maps sessions, roles, and the question", async () => {
    await withDataset(async (path) => {
      const first = (await loadLongMemEvalSamples(path, [0]))[0]!;
      expect(first.sampleIndex).toBe(0);
      expect(first.sessions).toHaveLength(2);
      expect(first.sessions[0]!.occurredAt.toISOString()).toBe("2023-05-20T02:21:00.000Z");
      expect(first.sessions[0]!.turns.map((turn) => turn.role)).toEqual([
        "user",
        "assistant",
        "user",
      ]);
      expect(first.question.questionType).toBe("single-session-user");
      expect(first.question.questionDate?.toISOString()).toBe("2023-05-30T23:40:00.000Z");
    });
  });

  test("parses the second sample's session date", async () => {
    await withDataset(async (path) => {
      const second = (await loadLongMemEvalSamples(path, [1]))[0]!;
      expect(second.sessions[0]!.occurredAt.toISOString()).toBe("2023-05-01T09:00:00.000Z");
    });
  });

  test("rejects out-of-range indexes", async () => {
    await withDataset(async (path) => {
      await expect(loadLongMemEvalSamples(path, [5])).rejects.toThrow("out of range");
    });
  });

  test("asserts the pin on the same read", async () => {
    await withDataset(async (path) => {
      const raw = await Bun.file(path).text();
      const samples = await loadLongMemEvalSamples(path, [0], sha256Hex(raw));
      expect(samples).toHaveLength(1);
      await expect(loadLongMemEvalSamples(path, [0], "deadbeef")).rejects.toThrow("pin mismatch");
    });
  });
});
