import { describe, expect, test } from "bun:test";

import { directorySectionHideable } from "./directory-sections";

describe("an empty sidebar section under Hide empty sidebar sections", () => {
  test("a section with rows is never hidden", () => {
    expect(directorySectionHideable({ itemCount: 2, dragging: false })).toBe(false);
  });

  test("an empty section is hidden", () => {
    expect(directorySectionHideable({ itemCount: 0, dragging: false })).toBe(true);
  });

  test("an empty section that takes drops comes back while a row is dragged", () => {
    expect(
      directorySectionHideable({ itemCount: 0, dragging: true, revealWhileDragging: true }),
    ).toBe(false);
  });

  test("an empty section that takes no drops stays hidden while a row is dragged", () => {
    expect(directorySectionHideable({ itemCount: 0, dragging: true })).toBe(true);
  });
});
