import type { createLowlight } from "lowlight";

// Hast types are derived through lowlight's own return type rather than
// `import ... from "hast"` directly: `hast` is only a transitive dependency
// here (of `lowlight`/`hast-util-to-html`), not hoisted as a module this
// workspace can resolve on its own, whereas `lowlight`'s declaration file
// resolves it fine from its own location.
type Highlighter = ReturnType<typeof createLowlight>;
export type HastRoot = ReturnType<Highlighter["highlight"]>;
type HastRootContent = HastRoot["children"][number];
export type HastElement = Extract<HastRootContent, { type: "element" }>;
export type HastText = Extract<HastRootContent, { type: "text" }>;

/**
 * Splits a lowlight/hast highlight tree into one self-contained HTML string
 * per source line.
 *
 * A naive `toHtml(tree).split("\n")` breaks whenever a token spans multiple
 * lines (block comments, template strings, …): the opening `<span>` ends up
 * on one line and its closing tag several lines later, so each returned
 * fragment would no longer be valid, independently-renderable HTML. This
 * walks the tree instead, closing the whole chain of enclosing elements at
 * each line boundary and reopening it at the start of the next line.
 */
export function splitHighlightedLines(tree: HastRoot): string[] {
  const lines: string[] = [];
  let current = "";

  visit(tree.children, []);

  // A trailing "\n" ends the last real line without starting a new one, so
  // it must not produce a phantom empty line after it. A blank line that
  // occurs *within* the file was already emitted by `flush` below and isn't
  // affected by this check (it runs once, after the whole tree is walked).
  if (current !== "") lines.push(current);

  return lines;

  function flush() {
    lines.push(current);
    current = "";
  }

  function visit(nodes: HastRootContent[], openStack: HastElement[]) {
    for (const node of nodes) {
      if (node.type === "text") {
        const parts = node.value.split("\n");
        for (let i = 0; i < parts.length; i++) {
          current += escapeHtml(parts[i]);
          if (i < parts.length - 1) {
            for (let j = openStack.length - 1; j >= 0; j--) current += closeTag(openStack[j]);
            flush();
            for (const el of openStack) current += openTag(el);
          }
        }
      } else if (node.type === "element") {
        current += openTag(node);
        visit(node.children, [...openStack, node]);
        current += closeTag(node);
      }
      // Comments/doctypes don't occur in lowlight's highlight output.
    }
  }
}

function openTag(el: HastElement): string {
  const classes = classNameOf(el);
  return classes ? `<${el.tagName} class="${escapeHtml(classes)}">` : `<${el.tagName}>`;
}

function closeTag(el: HastElement): string {
  return `</${el.tagName}>`;
}

function classNameOf(el: HastElement): string {
  const className = el.properties?.className;
  if (Array.isArray(className)) return className.join(" ");
  if (typeof className === "string") return className;
  return "";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Splits raw text into lines using the exact same "\n"-boundary rule as
 * `splitHighlightedLines` above (a trailing final "\n" doesn't create a
 * phantom empty last line; interior blank lines are kept; on a CRLF file the
 * "\r" stays attached to the end of the line, since only "\n" is a boundary).
 *
 * Highlighting never inserts, removes or reorders characters — it only wraps
 * substrings in spans — so the set of line-break positions in raw text is
 * always identical to what `splitHighlightedLines` would produce for the
 * same text. `find-in-text.ts` uses this to index match positions that agree
 * with the `data-line` numbers the code view actually renders, without
 * paying for a highlighting pass just to search.
 */
export function splitPlainLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
