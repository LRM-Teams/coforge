import { describe, expect, it } from "bun:test";

import {
  linkifyKeyPointSourceAttributions,
  memberReportKeyPointHref,
} from "./key-point-source-links";

describe("memberReportKeyPointHref", () => {
  it("embeds returnTo so the member report can navigate back", () => {
    expect(memberReportKeyPointHref("acme", "report-1", "/w/acme/records/overview-1")).toBe(
      "/w/acme/records/report-1?returnTo=%2Fw%2Facme%2Frecords%2Foverview-1",
    );
  });
});

describe("linkifyKeyPointSourceAttributions", () => {
  const sources = [
    { reportId: "r-alice", displayName: "Alice" },
    { reportId: "r-bob", displayName: "Bob Chen" },
  ] as const;
  const link = { workspaceSlug: "acme", returnTo: "/w/acme/records/overview-1" };

  it("turns bare @Name into a returnable member-report link", () => {
    const out = linkifyKeyPointSourceAttributions(
      "- 完成模板拖拽 @Alice\n- 联调 Daemon @Bob Chen",
      sources,
      link,
    );
    expect(out).toContain(
      "[@Alice](/w/acme/records/r-alice?returnTo=%2Fw%2Facme%2Frecords%2Foverview-1)",
    );
    expect(out).toContain(
      "[@Bob Chen](/w/acme/records/r-bob?returnTo=%2Fw%2Facme%2Frecords%2Foverview-1)",
    );
  });

  it("normalizes existing report links to include returnTo and @ prefix", () => {
    const out = linkifyKeyPointSourceAttributions(
      "- 完成模板拖拽 [Alice](/w/acme/records/r-alice)",
      sources,
      link,
    );
    expect(out).toBe(
      "- 完成模板拖拽 [@Alice](/w/acme/records/r-alice?returnTo=%2Fw%2Facme%2Frecords%2Foverview-1)",
    );
  });

  it("linkifies parenthetical attributions", () => {
    const out = linkifyKeyPointSourceAttributions("- 完成模板拖拽（Alice）", sources, link);
    expect(out).toContain(
      "（[@Alice](/w/acme/records/r-alice?returnTo=%2Fw%2Facme%2Frecords%2Foverview-1)）",
    );
  });

  it("is idempotent when already linkified", () => {
    const once = linkifyKeyPointSourceAttributions("- 完成 @Alice", sources, link);
    const twice = linkifyKeyPointSourceAttributions(once, sources, link);
    expect(twice).toBe(once);
  });
});
