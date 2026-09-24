import { useMemo, type ComponentPropsWithoutRef } from "react";
import Markdown, { type Components, type Options } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

import { MESSAGE_REMARK_PLUGINS, escapeLiteralHtml } from "#src/lib/message-syntax";
import { mentionHandlesByToken, rehypeReferenceChips } from "./message-markdown";
import type { MentionRef } from "./mention-text";

/**
 * A message body as a one-paragraph preview, for cards that clamp it to a line or two (the
 * Activity page). It parses the same Markdown dialect and sanitizes the same way as `MessageBody`
 * and shows mentions as chips, but flattens every block (paragraphs, headings, lists, quotes,
 * tables, code blocks) into inline text, and renders nothing interactive: the card around it is
 * one link, and a link or button inside it would be invalid markup and steal the click. Channel and
 * thread references read as their plain `#name`, as on a Saved card.
 */
export function MessagePreview({
  body,
  mentions = [],
}: {
  body: string;
  mentions?: readonly MentionRef[];
}) {
  const source = useMemo(() => escapeLiteralHtml(body), [body]);
  const handles = useMemo(() => mentionHandlesByToken(mentions), [mentions]);
  const hasReference = source.includes("<@");
  const rehypePlugins = useMemo<NonNullable<Options["rehypePlugins"]>>(
    () =>
      hasReference
        ? [rehypeSanitize, [rehypeReferenceChips, { mentions: handles }]]
        : [rehypeSanitize],
    [hasReference, handles],
  );
  return (
    <Markdown
      remarkPlugins={MESSAGE_REMARK_PLUGINS}
      rehypePlugins={rehypePlugins}
      components={PREVIEW_COMPONENTS}
    >
      {source}
    </Markdown>
  );
}

function Inline({ children }: ComponentPropsWithoutRef<"span">) {
  return <span>{children}</span>;
}

/** A block element that ends a sentence-like unit: its text is followed by a space. */
function InlineWithSpace({ children }: ComponentPropsWithoutRef<"span">) {
  return <span>{children} </span>;
}

function Space() {
  return <span> </span>;
}

const PREVIEW_COMPONENTS: Components = {
  p: InlineWithSpace,
  h1: InlineWithSpace,
  h2: InlineWithSpace,
  h3: InlineWithSpace,
  h4: InlineWithSpace,
  h5: InlineWithSpace,
  h6: InlineWithSpace,
  blockquote: Inline,
  ul: Inline,
  ol: Inline,
  li: InlineWithSpace,
  table: Inline,
  thead: Inline,
  tbody: Inline,
  tr: InlineWithSpace,
  th: InlineWithSpace,
  td: InlineWithSpace,
  br: Space,
  hr: Space,
  // A task-list checkbox is a control; the item's text is enough.
  input: () => null,
  pre: ({ children }) => <span className="font-mono">{children}</span>,
  code: ({ children }) => (
    <code className="rounded-sm bg-secondary px-1 font-mono text-[0.8125rem]">{children}</code>
  ),
  a: ({ children }) => <span className="text-brand-secondary underline">{children}</span>,
  img: ({ alt }) => <span>{alt}</span>,
};
