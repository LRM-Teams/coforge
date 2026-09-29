import { expect, test } from "bun:test";
import { parseLocomoDateTime, turnBody } from "../src/locomo-time";
import { assertLocomoPin, loadLocomoSample, LOCOMO10_SHA256, DEFAULT_LOCOMO_PATH } from "../src/locomo";

test("parses LoCoMo session stamps into UTC instants", () => {
  expect(parseLocomoDateTime("9:36 am on 2 April, 2023", 0).toISOString()).toBe(
    "2023-04-02T09:36:00.000Z",
  );
  expect(parseLocomoDateTime("2:05 pm on 15 December, 2022", 0).toISOString()).toBe(
    "2022-12-15T14:05:00.000Z",
  );
});

test("renders photo turns as caption text without image URLs", () => {
  expect(turnBody({ text: "look", blipCaption: "a lake", query: "lake" })).toContain(
    "image description: a lake",
  );
  expect(turnBody({ text: "look", blipCaption: "a lake" })).not.toContain("http");
});

test("pins locomo10 and loads conv-26 headline slice", async () => {
  const raw = await Bun.file(DEFAULT_LOCOMO_PATH).text();
  expect(() => assertLocomoPin(raw, LOCOMO10_SHA256)).not.toThrow();
  const sample = await loadLocomoSample(DEFAULT_LOCOMO_PATH, "conv-26", 6);
  expect(sample.speakerA).toBe("Caroline");
  expect(sample.speakerB).toBe("Melanie");
  expect(sample.sessions.length).toBeGreaterThan(0);
  expect(sample.questions).toHaveLength(6);
  expect(sample.questions.every((question) => question.category !== 5)).toBe(true);
});
