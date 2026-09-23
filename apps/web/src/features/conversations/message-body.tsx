import { useMemo, type ComponentPropsWithoutRef, type KeyboardEvent } from "react";
import { Link } from "@tanstack/react-router";
import Markdown, { type Components, type ExtraProps, type Options } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import type { Element } from "hast";

import { MESSAGE_REMARK_PLUGINS } from "#src/lib/message-syntax";
import {
  escapeLiteralHtml,
  mentionHandlesByToken,
  rehypeChannelReferenceChips,
  rehypeMentionChips,
  rehypeTaskReferenceChips,
  type ChipMention,
} from "./message-markdown";
import type { MentionRef } from "./mention-text";
import "./message-markdown.css";

/** Stable empty set for the common "no task references to make clickable" case. */
const NO_TASK_NUMBERS: ReadonlySet<number> = new Set();

/**
 * A message body rendered as Markdown with mentions highlighted as inline chips.
 *
 * The source is prepared by `escapeLiteralHtml`, then parsed in the message dialect
 * (`MESSAGE_REMARK_PLUGINS`, shared with the send-time reference recognizer: GFM tables, task
 * lists, strikethrough, autolinks, and single-newline breaks), so a body written as plain text keeps its
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
  plainMentions,
  viewerHandle,
  onOpenAgentProfile,
  taskReferences,
  onOpenTask,
  channelNames,
}: {
  body: string;
  mentions?: readonly MentionRef[];
  /** Plain-`@handle` display resolution: every conversation member's handle → chip. Absent,
   * plain handles render as literal text (the stored body is never rewritten either way). */
  plainMentions?: Map<string, ChipMention>;
  viewerHandle?: string;
  /** Opens the Agent profile panel when an Agent mention chip is activated. Present only where
   * the conversation owns that slot; absent, Agent chips render as inert highlights (the
   * previous behavior), never dead controls. */
  onOpenAgentProfile?: (agentId: string) => void;
  /** The conversation's own task numbers: a stored `task #N` reference or a bare `#N` naming one of
   * them becomes a clickable chip. Any other bare `#N` stays prose. */
  taskReferences?: ReadonlySet<number>;
  /** Opens a task-reference chip's detail popup. Absent, a reference stays a plain highlight. */
  onOpenTask?: (number: number) => void;
  /** Channel id → current name, for a host that can navigate: a stored channel reference becomes a
   * link to that channel, under its current name when listed here and the name the reference
   * stored otherwise. Absent (e.g. a Saved card, itself one link), a reference reads as plain
   * `#name`. */
  channelNames?: ReadonlyMap<string, string>;
}) {
  const source = useMemo(() => escapeLiteralHtml(body), [body]);
  const handles = useMemo(() => mentionHandlesByToken(mentions), [mentions]);
  // Typed against react-markdown's own plugin list so the plugin-with-options tuple form
  // type-checks without a cast.
  const rehypePlugins = useMemo<NonNullable<Options["rehypePlugins"]>>(
    () => [
      rehypeSanitize,
      // First: a channel chip is finished markup the later passes leave alone.
      [rehypeChannelReferenceChips, { currentNames: channelNames }],
      [rehypeMentionChips, { handles, viewerHandle, plain: plainMentions }],
      [rehypeTaskReferenceChips, { numbers: taskReferences ?? NO_TASK_NUMBERS }],
    ],
    [handles, viewerHandle, plainMentions, taskReferences, channelNames],
  );
  // The `span` override recognises the Agent mention chip (`data-mention-agent-id`, injected by
  // `rehypeMentionChips`) and the task-reference chip (`data-task-reference-number`, injected by
  // `rehypeTaskReferenceChips`), and makes each an accessible button; the channel-reference chip
  // (`data-channel-id`, injected by `rehypeChannelReferenceChips`) becomes a link to the channel.
  // Every other span passes through.
  const components = useMemo<Components>(
    () => ({ ...MARKDOWN_COMPONENTS, span: chipSpan(onOpenAgentProfile, onOpenTask) }),
    [onOpenAgentProfile, onOpenTask],
  );

  return (
    <div className="message-markdown">
      <Markdown
        remarkPlugins={MESSAGE_REMARK_PLUGINS}
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
 * The `span` renderer. An Agent mention chip carries `data-mention-agent-id` and a task-reference
 * chip that names a conversation task carries `data-task-reference-number` (see
 * `message-markdown.ts`); when the matching handler is provided each becomes a keyboard- and
 * pointer-accessible control. A channel-reference chip carries `data-channel-id` and becomes a
 * router link to that channel: it navigates, so it is a real link (open in a new tab, copy the
 * address) rather than a button. All other spans — including human mention chips and task chips
 * whose task is gone — render unchanged.
 */
function chipSpan(
  onOpenAgentProfile?: (agentId: string) => void,
  onOpenTask?: (number: number) => void,
) {
  return function ChipSpan({
    node,
    children,
    className,
    ...props
  }: ComponentPropsWithoutRef<"span"> & ExtraProps) {
    void node;
    // `data-*` attributes arrive on props via react-markdown's hast → props mapping.
    const channelId = (props as Record<string, unknown>)["data-channel-id"];
    if (typeof channelId === "string") {
      return (
        // `data-channel-id` stays on the anchor so a copied selection reads it back as `#name`
        // (see `selection-copy.ts`), not as a Markdown link to the app's URL.
        <Link
          to="/messages/channels/$channelId"
          params={{ channelId }}
          className={className}
          data-channel-id={channelId}
        >
          {children}
        </Link>
      );
    }
    const agentId = (props as Record<string, unknown>)["data-mention-agent-id"];
    const taskNumber = (props as Record<string, unknown>)["data-task-reference-number"];
    const openTask =
      typeof taskNumber === "number" && onOpenTask ? () => onOpenTask(taskNumber) : undefined;
    const open =
      typeof agentId === "string" && onOpenAgentProfile
        ? () => onOpenAgentProfile(agentId)
        : openTask;
    if (open) {
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
