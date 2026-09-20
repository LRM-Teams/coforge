import { describe, expect, test } from "bun:test";
import { sanitizeMermaidSvg } from "../src/features/records/report-editor/normalize-mermaid-chart";

describe("sanitizeMermaidSvg", () => {
  test("makes HTML void <br> tags XML-safe inside foreignObject markup", () => {
    const svg =
      '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">' +
      "<p>本周工作<br>产品</p></div></foreignObject></svg>";

    expect(sanitizeMermaidSvg(svg)).toBe(
      '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">' +
        "<p>本周工作<br/>产品</p></div></foreignObject></svg>",
    );
  });

  test("strips erroneous </br> closers Mermaid sometimes emits", () => {
    expect(sanitizeMermaidSvg("<p>a</br>b</p>")).toBe("<p>ab</p>");
  });

  test("leaves already self-closed br tags alone", () => {
    expect(sanitizeMermaidSvg("<p>a<br/>b<br />c</p>")).toBe("<p>a<br/>b<br />c</p>");
  });
});
