import { describe, expect, test } from "bun:test";

import { fragmentHtmlToMarkdown } from "../src/features/conversations/selection-copy";

describe("fragmentHtmlToMarkdown", () => {
  test("keeps emphasis as markdown marks", () => {
    expect(fragmentHtmlToMarkdown("<p>Hello <strong>bold</strong> and <em>italic</em></p>")).toBe(
      "Hello **bold** and *italic*",
    );
  });

  test("keeps a link's target", () => {
    expect(fragmentHtmlToMarkdown('<p><a href="https://example.com">link</a></p>')).toBe(
      "[link](https://example.com)",
    );
  });

  test("keeps inline code and fenced code", () => {
    expect(fragmentHtmlToMarkdown("<p><code>x = 1</code></p>")).toBe("`x = 1`");
    expect(fragmentHtmlToMarkdown("<pre><code>one\ntwo</code></pre>")).toBe("```\none\ntwo\n```");
  });

  test("keeps GFM strikethrough and tables instead of flattening them", () => {
    expect(fragmentHtmlToMarkdown("<p><del>gone</del></p>")).toBe("~gone~");
    const table =
      "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>";
    expect(fragmentHtmlToMarkdown(table)).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  test("keeps a list as a markdown list", () => {
    expect(fragmentHtmlToMarkdown("<ul><li>one</li><li>two</li></ul>")).toBe("-   one\n-   two");
  });

  test("a mention chip copies as its plain @label", () => {
    const chip =
      '<span class="message-markdown-mention rounded-sm px-0.5 font-medium bg-brand-primary text-brand-secondary">@alice</span>';
    expect(fragmentHtmlToMarkdown(`<p>hey ${chip}, look</p>`)).toBe("hey @alice, look");
  });

  test("drops the toolbar's own UI if it ever lands inside a fragment", () => {
    expect(fragmentHtmlToMarkdown("<p>clean</p>")).toBe("clean");
  });
});
