import type { Root } from "mdast";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * The Markdown dialect of a message body: GFM (tables, task lists, strikethrough, autolinks) and
 * single-newline breaks. The single definition shared by the renderer (`message-body.tsx`) and the
 * send-time reference recognizer (`message-references.ts`), so the two can never disagree about
 * what is a link, a code span or prose.
 */
export const MESSAGE_REMARK_PLUGINS = [remarkGfm, remarkBreaks];

const parser = unified().use(remarkParse).use(MESSAGE_REMARK_PLUGINS);

/**
 * The Markdown syntax tree of a body as written. Parsing only reads syntax (GFM's autolinks
 * included); every node keeps its `position` offsets into `body`.
 */
export function parseMessageSyntax(body: string): Root {
  return parser.parse(body);
}
