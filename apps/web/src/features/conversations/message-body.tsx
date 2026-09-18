import { useMemo, type ComponentPropsWithoutRef, type KeyboardEvent } from "react";
import Markdown, { type Components, type ExtraProps, type Options } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { Element } from "hast";

import { escapeLiteralHtml, mentionHandlesByToken, rehypeMentionChips } from "./message-markdown";
import type { MentionRef } from "./mention-text";
import "./message-markdown.css";

/** Stable across renders: neither list depends on the message being rendered. */
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

/**
 * A message body rendered as Markdown with mentions highlighted as inline chips.
 *
 * The source is prepared by `escapeLiteralHtml`, then parsed with GFM (tables, task lists,
 * strikethrough, autolinks) and single-newline breaks, so a body written as plain text keeps its
 * line structure. `rehype-sanitize` runs before the chip pass: message bodies are untrusted, and
 * `react-markdown`'s default schema already refuses raw HTML, `javascript:` URLs and disallowed
 * attributes. Chips are injected afterwards because they are trusted, fixed markup (see
 * `message-markdown.ts`).
 *
 * Deliberate scope boundaries:
 *
 * - A Markdown image renders as a labeled link rather than an auto-loaded `<img>`. Auto-loading
 *   would let any message author — including an Agent — make every viewer's browser fetch an
 *   arbitrary URL, which is a new outbound-request boundary that has not been approved.
 * - Code blocks render as plain monospace without syntax highlighting, so the conversations
 *   chunk does not pull in the Records editor's highlighter.
 */
export function MessageBody({
  body,
  mentions = [],
  viewerHandle,
  onOpenAgentProfile,
}: {
  body: string;
  mentions?: readonly MentionRef[];
  viewerHandle?: string;
  /** Opens the Agent profile panel when an Agent mention chip is activated. Present only where
   * the conversation owns that slot; absent, Agent chips render as inert highlights (the
   * previous behavior), never dead controls. */
  onOpenAgentProfile?: (agentId: string) => void;
}) {
  const source = useMemo(() => escapeLiteralHtml(body), [body]);
  const handles = useMemo(() => mentionHandlesByToken(mentions), [mentions]);
  // Typed against react-markdown's own plugin list so the plugin-with-options tuple form
  // type-checks without a cast.
  const rehypePlugins = useMemo<NonNullable<Options["rehypePlugins"]>>(
    () => [rehypeSanitize, [rehypeMentionChips, { handles, viewerHandle }]],
    [handles, viewerHandle],
  );
  // The `span` override recognises the Agent mention chip (`data-mention-agent-id`, injected by
  // `rehypeMentionChips`) and makes it an accessible button; every other span passes through.
  const components = useMemo<Components>(
    () => ({ ...MARKDOWN_COMPONENTS, span: mentionSpan(onOpenAgentProfile) }),
    [onOpenAgentProfile],
  );

  return (
    <div className="message-markdown">
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {source}
      </Markdown>
    </div>
  );
}

const MARKDOWN_COMPONENTS = {
  // `react-markdown` renders a fenced block as <pre><code class="language-x">. The `pre`
  // override owns the block: it reads the language for the label and renders the code itself.
  pre: CodeBlock,
  // Images are surfaced as a link, not fetched. See the component doc comment.
  img: ImageLink,
  a: ExternalLink,
  // Tables scroll inside the message column instead of widening it.
  table: ({ children }: ComponentPropsWithoutRef<"table">) => (
    <div className="message-markdown-table">
      <table>{children}</table>
    </div>
  ),
};

/**
 * The `span` renderer. An Agent mention chip carries `data-mention-agent-id` (see
 * `message-markdown.ts`); when a handler is provided it becomes a keyboard- and pointer-
 * accessible control that opens that Agent's profile panel. All other spans — including human
 * mention chips, which have no profile panel — render unchanged.
 */
function mentionSpan(onOpenAgentProfile?: (agentId: string) => void) {
  return function MentionSpan({
    node,
    children,
    className,
    ...props
  }: ComponentPropsWithoutRef<"span"> & ExtraProps) {
    void node;
    // `data-*` attributes arrive on props via react-markdown's hast → props mapping.
    const agentId = (props as Record<string, unknown>)["data-mention-agent-id"];
    if (typeof agentId === "string" && onOpenAgentProfile) {
      const open = () => onOpenAgentProfile(agentId);
      return (
        <span
          {...props}
          className={className}
          role="button"
          tabIndex={0}
          onClick={open}
          onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              open();
            }
          }}
        >
          {children}
        </span>
      );
    }
    return (
      <span {...props} className={className}>
        {children}
      </span>
    );
  };
}

function CodeBlock({ node, children, ...props }: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  // `node` is react-markdown's hast node, not a DOM attribute; destructuring it out keeps it off
  // the rendered element.
  const code = node?.children.find(
    (child): child is Element => child.type === "element" && child.tagName === "code",
  );
  const className = code?.properties?.className;
  const language = Array.isArray(className)
    ? className.find((name) => name.startsWith("language-"))?.slice("language-".length)
    : undefined;

  return (
    <div className="message-markdown-code">
      {language && <span className="message-markdown-code-language">{language}</span>}
      {/* `children` is already the rendered <code> element; wrapping it again would nest two. */}
      <pre {...props}>{children}</pre>
    </div>
  );
}

function ExternalLink({ node, children, ...props }: ComponentPropsWithoutRef<"a"> & ExtraProps) {
  // `node` is react-markdown's hast node, not a DOM attribute; destructuring it out keeps it off
  // the rendered element.
  void node;
  return (
    // Untrusted links open in a new tab without handing the opener over via `window.opener`.
    <a target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  );
}

function ImageLink({ node, src, alt }: ComponentPropsWithoutRef<"img"> & ExtraProps) {
  void node;
  const label = alt?.trim() || src || "";
  if (!src) return <span>{label}</span>;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="message-markdown-image">
      {label}
    </a>
  );
}
