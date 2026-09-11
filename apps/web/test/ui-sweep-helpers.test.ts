import { describe, expect, test } from "bun:test";
import { filterSweepOptions, isInsideViewportScroller } from "../scripts/ui-sweep-helpers.mjs";

describe("UI sweep viewport checks", () => {
  const style = (element: { overflowX?: string }) => ({
    overflowX: element.overflowX ?? "visible",
  });

  test("exempts a descendant clipped by an in-viewport horizontal scroller", () => {
    const scroller = {
      overflowX: "auto",
      scrollWidth: 700,
      clientWidth: 300,
      parentElement: null,
      getBoundingClientRect: () => ({ left: 20, right: 320 }),
    };
    expect(isInsideViewportScroller({ parentElement: scroller }, 390, style)).toBe(true);
  });

  test("does not hide overflow when the scroller itself exceeds the viewport", () => {
    const scroller = {
      overflowX: "scroll",
      scrollWidth: 700,
      clientWidth: 430,
      parentElement: null,
      getBoundingClientRect: () => ({ left: 0, right: 430 }),
    };
    expect(isInsideViewportScroller({ parentElement: scroller }, 390, style)).toBe(false);
  });

  test("filters themes and viewports by their environment names", () => {
    expect(filterSweepOptions(["light", "dark"], "dark", "theme")).toEqual(["dark"]);
    expect(filterSweepOptions([{ name: "390" }, { name: "1440" }], "390", "viewport")).toEqual([
      { name: "390" },
    ]);
  });
});
