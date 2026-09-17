import { expect, test } from "bun:test";
import {
  splitHighlightedLines,
  type HastElement,
  type HastRoot,
  type HastText,
} from "../src/features/projects/split-highlighted-lines";

function text(value: string): HastText {
  return { type: "text", value };
}

function span(className: string, children: HastElement["children"]): HastElement {
  return {
    type: "element",
    tagName: "span",
    properties: { className: [className] },
    children,
  };
}

function root(children: HastRoot["children"]): HastRoot {
  return { type: "root", children };
}

test("plain text with no highlighting spans is returned as a single line", () => {
  expect(splitHighlightedLines(root([text("hello world")]))).toEqual(["hello world"]);
});

test("a span that spans multiple lines is closed and reopened at each break", () => {
  const tree = root([span("hljs-comment", [text("/*\nfoo\n*/")])]);
  expect(splitHighlightedLines(tree)).toEqual([
    '<span class="hljs-comment">/*</span>',
    '<span class="hljs-comment">foo</span>',
    '<span class="hljs-comment">*/</span>',
  ]);
});

test("nested spans reopen the full chain on each new line", () => {
  const tree = root([span("a", [span("b", [text("x\ny")])])]);
  expect(splitHighlightedLines(tree)).toEqual([
    '<span class="a"><span class="b">x</span></span>',
    '<span class="a"><span class="b">y</span></span>',
  ]);
});

test("a trailing newline does not produce a phantom last line", () => {
  expect(splitHighlightedLines(root([text("line1\n")]))).toEqual(["line1"]);
  expect(splitHighlightedLines(root([text("line1\nline2\n")]))).toEqual(["line1", "line2"]);
});

test("empty lines within the file are preserved", () => {
  expect(splitHighlightedLines(root([text("a\n\nb")]))).toEqual(["a", "", "b"]);
});

test("text is HTML-escaped", () => {
  expect(splitHighlightedLines(root([text("<script>&nbsp;")]))).toEqual([
    "&lt;script&gt;&amp;nbsp;",
  ]);
});

test("an empty tree yields no lines", () => {
  expect(splitHighlightedLines(root([]))).toEqual([]);
});
