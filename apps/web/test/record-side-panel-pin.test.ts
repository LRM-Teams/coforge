import { expect, test } from "bun:test";

import { defaultSidePanelPinned } from "../src/features/records/record-side-panel-pin";

test("defaultSidePanelPinned matches historical auto-open surfaces", () => {
  expect(defaultSidePanelPinned("format")).toBe(true);
  expect(defaultSidePanelPinned("member-leader")).toBe(true);
  expect(defaultSidePanelPinned("member-assignee")).toBe(true);
  expect(defaultSidePanelPinned("plain")).toBe(false);
});
