import { expect, test } from "bun:test";
import { channelSendNeedsMemoryOffer, isExplicitMemoryQuestion } from "./explicit-memory-answer";

test("an explicit @memory question is a token, not a substring", () => {
  expect(isExplicitMemoryQuestion("@memory When did Caroline go?")).toBe(true);
  expect(isExplicitMemoryQuestion("please @memory the date")).toBe(true);
  expect(isExplicitMemoryQuestion("email me@memory.example")).toBe(false);
  expect(isExplicitMemoryQuestion("Caroline went to the group")).toBe(false);
  expect(
    isExplicitMemoryQuestion(
      "<@agent:40892ec7-004d-4a0c-89bf-ed4e2e79ab0e> When did Caroline go?",
      "40892ec7-004d-4a0c-89bf-ed4e2e79ab0e",
    ),
  ).toBe(true);
  expect(
    isExplicitMemoryQuestion(
      "<@agent:other> When did Caroline go?",
      "40892ec7-004d-4a0c-89bf-ed4e2e79ab0e",
    ),
  ).toBe(false);
});

test("a later question may still be answered after an earlier offer", () => {
  const earlier = new Date("2026-09-22T09:00:00.000Z");
  const laterQuestion = new Date("2026-09-22T09:05:00.000Z");
  expect(
    channelSendNeedsMemoryOffer({ latestQuestionAt: laterQuestion, latestOfferAt: earlier }),
  ).toBe(true);
  expect(
    channelSendNeedsMemoryOffer({
      latestQuestionAt: earlier,
      latestOfferAt: laterQuestion,
    }),
  ).toBe(false);
  expect(channelSendNeedsMemoryOffer({ latestQuestionAt: null, latestOfferAt: null })).toBe(false);
});
