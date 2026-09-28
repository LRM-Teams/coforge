import { expect, test } from "bun:test";

import {
  readMermaidViewPreference,
  resolveMermaidViewMode,
  writeMermaidViewPreference,
} from "#src/features/records/report-editor/mermaid-view-preference";

const CHART = "flowchart TD\n  A-->B";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

test("resolveMermaidViewMode prefers explicit attr over fence and preference", () => {
  const storage = memoryStorage();
  writeMermaidViewPreference(CHART, "source", storage);
  expect(
    resolveMermaidViewMode(
      {
        attrView: "diagram",
        fenceView: "source",
        chart: CHART,
      },
      storage,
    ),
  ).toBe("diagram");
});

test("resolveMermaidViewMode uses fence when attr is default both", () => {
  const storage = memoryStorage();
  writeMermaidViewPreference(CHART, "source", storage);
  expect(
    resolveMermaidViewMode(
      {
        attrView: "both",
        fenceView: "diagram",
        chart: CHART,
      },
      storage,
    ),
  ).toBe("diagram");
});

test("resolveMermaidViewMode falls back to client preference across refresh", () => {
  const storage = memoryStorage();
  writeMermaidViewPreference(CHART, "diagram", storage);
  expect(readMermaidViewPreference(CHART, storage)).toBe("diagram");
  expect(
    resolveMermaidViewMode(
      {
        attrView: "both",
        fenceView: "both",
        chart: CHART,
      },
      storage,
    ),
  ).toBe("diagram");
});

test("resolveMermaidViewMode defaults to both when nothing is stored", () => {
  const storage = memoryStorage();
  expect(
    resolveMermaidViewMode(
      {
        attrView: "both",
        fenceView: "both",
        chart: `flowchart TD\n  unique-${Date.now()}-->Z`,
      },
      storage,
    ),
  ).toBe("both");
});
