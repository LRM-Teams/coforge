import { describe, expect, it } from "bun:test";

import {
  linkifyKeyPointSourceAttributions,
  memberReportKeyPointHref,
} from "./key-point-source-links";

describe("memberReportKeyPointHref", () => {
  it("embeds returnTo so the member report can navigate back", () => {
    expect(memberReportKeyPointHref("report-1", "/records/overview-1")).toBe(
      "/records/report-1?returnTo=%2Frecords%2Foverview-1",
    );
  });
});

describe("linkifyKeyPointSourceAttributions", () => {
  const sources = [
    { reportId: "r-alice", displayName: "Alice" },
    { reportId: "r-bob", displayName: "Bob Chen" },
  ] as const;
  const returnTo = "/records/overview-1";

  it("turns bare @Name into a returnable member-report link", () => {
    const out = linkifyKeyPointSourceAttributions(
      "- 完成模板拖拽 @Alice\n- 联调 Daemon @Bob Chen",
      sources,
      returnTo,
    );
    expect(out).toContain("[@Alice](/records/r-alice?returnTo=%2Frecords%2Foverview-1)");
    expect(out).toContain("[@Bob Chen](/records/r-bob?returnTo=%2Frecords%2Foverview-1)");
  });

  it("normalizes existing report links to include returnTo and @ prefix", () => {
    const out = linkifyKeyPointSourceAttributions(
      "- 完成模板拖拽 [Alice](/records/r-alice)",
      sources,
      returnTo,
    );
    expect(out).toBe("- 完成模板拖拽 [@Alice](/records/r-alice?returnTo=%2Frecords%2Foverview-1)");
  });

  it("linkifies parenthetical attributions", () => {
    const out = linkifyKeyPointSourceAttributions("- 完成模板拖拽（Alice）", sources, returnTo);
    expect(out).toContain("（[@Alice](/records/r-alice?returnTo=%2Frecords%2Foverview-1)）");
  });

  it("is idempotent when already linkified", () => {
    const once = linkifyKeyPointSourceAttributions("- 完成 @Alice", sources, returnTo);
    const twice = linkifyKeyPointSourceAttributions(once, sources, returnTo);
    expect(twice).toBe(once);
  });
});
