import { expect, test } from "bun:test";

import { isVisibleTemplateSubmission } from "@/server/records/template-submission-visibility";

test("draft template submissions stay hidden under the parent", () => {
  expect(isVisibleTemplateSubmission("draft")).toBe(false);
});

test("submitted and shared template submissions are visible under the parent", () => {
  expect(isVisibleTemplateSubmission("submitted")).toBe(true);
  expect(isVisibleTemplateSubmission("shared")).toBe(true);
});
