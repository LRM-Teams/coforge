import { splitCodeSpans } from "@lrm/coforge-sdk/internal";
import type { Root } from "mdast";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** A URI scheme right after `<` means a GFM autolink, not an HTML tag. */
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * The Markdown dialect of a message body: GFM (tables, task lists, strikethrough, autolinks) and
 * single-newline breaks, read from `escapeLiteralHtml(body)`. The single definition shared by the
 * renderer (`message-body.tsx`) and the send-time reference recognizer (`message-references.ts`),
 * so the two can never disagree about what is a link, a code span or prose.
 */
export const MESSAGE_REMARK_PLUGINS = [remarkGfm, remarkBreaks];

const parser = unified().use(remarkParse).use(MESSAGE_REMARK_PLUGINS);

/**
 * The Markdown syntax tree of a Markdown source (`escapeLiteralHtml(body)`, the renderer's input).
 * Parsing only reads syntax (GFM's autolinks included); every node keeps its `position` offsets
 * into `source`.
 */
export function parseMessageSyntax(source: string): Root {
  return parser.parse(source);
}

/**
 * Escapes HTML-looking text outside code spans so Markdown renders it literally, matching the
 * plain-text rendering this replaces.
 *
 * Only `<` is escaped. Escaping `&` as well would corrupt a bare URL autolink: GFM reads the
 * literal `https://x?a=1&amp;b=2` as the URL text and escapes its `&` again, so the link and its
 * label both end up showing `&amp;`. Decoding an entity such as `&lt;` into `<` is ordinary
 * Markdown behavior and loses no information.
 *
 * Code spans and fences pass through byte-for-byte: their contents already render as literal
 * code, and rewriting them would corrupt the sample the author wrote.
 */
export function escapeLiteralHtml(body: string): string {
  return splitCodeSpans(body)
    .map((segment) => {
      if (segment.code) return segment.text;
      return segment.text.replace(/</g, (character, offset: number, whole: string) => {
        const rest = whole.slice(offset + 1);
        // `<https://…>` is a GFM autolink and `<@agent:uuid>` is a mention token. Both must
        // keep their `<` or the autolink and the chip are destroyed.
        if (URI_SCHEME.test(rest) || rest.startsWith("@")) return character;
        return "&lt;";
      });
    })
    .join("");
}
