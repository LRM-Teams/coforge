/**
 * Markdown source preparation and mention-chip substitution for a message body.
 *
 * A message body is untrusted text — written by a human or an Agent — and until now it
 * rendered as literal text. Two existing behaviors must survive the move to Markdown rendering:
 *
 * 1. Raw HTML stays literal. `react-markdown` drops HTML by default, which would silently
 *    delete a body such as `<div>x</div>` — a data-loss regression, not a safety win. Every
 *    HTML-looking `<` outside code is escaped so it renders as the characters the author typed.
 *    GFM autolinks (`<https://…>`) and mention tokens keep their `<`.
 * 2. A stored `<@kind:uuid>` token still renders as a mention chip, and still never inside a
 *    code span or fence — the same rule `splitCodeSpans` gives the composer and the server.
 *
 * Chips are injected *after* `rehype-sanitize` runs. The sanitizer strips `className`, and the
 * nodes injected here are trusted — a fixed `span` whose only text is a resolved handle — so
 * they need not pass the untrusted-content schema. Nothing sanitizer-relevant is added before
 * it runs.
 */
import { MENTION_TOKEN_PATTERN, splitCodeSpans } from "@lrm/coforge-sdk/internal";
import type { Element, Root, Text } from "hast";

import type { MentionRef } from "./mention-text";

/** A URI scheme right after `<` means a GFM autolink, not an HTML tag. */
const URI_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Complete class literals so Tailwind's source scan emits every utility. The chip treatment
 * matches the one the plain-text renderer used: a soft brand fill, and the stronger solid fill
 * for a mention of the viewing user (the way Slack marks "@you"). `message-markdown-mention` is
 * the stable hook the stylesheet and the component use to recognise a chip.
 */
const CHIP_BASE = "message-markdown-mention rounded-sm px-0.5 font-medium";
export const MENTION_CHIP_CLASS = `${CHIP_BASE} bg-brand-primary text-brand-secondary`;
export const MENTION_CHIP_SELF_CLASS = `${CHIP_BASE} bg-brand-solid text-white`;
/** Added to an Agent chip so the renderer can recognise the clickable variant and the
 * stylesheet can give it a pointer/hover affordance. A human chip never gets this. */
export const MENTION_CHIP_AGENT_CLASS = "message-markdown-mention-agent";

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

/** A resolved mention as a chip needs it: the handle to show, plus the Agent id to open its
 * profile panel on click (absent for a human mention — there is no human profile panel). */
export type ChipMention = { handle: string; agentId?: string };

/**
 * The resolved mention for every token in a body, keyed the way `MENTION_TOKEN_PATTERN`
 * spells the token (`user:<uuid>` / `agent:<uuid>`, lower-cased). A token with no row here
 * degrades to its raw text rather than a phantom chip. An `agent` mention carries its
 * `actorId` as `agentId` so the chip can open that Agent's profile panel.
 */
export function mentionHandlesByToken(mentions: readonly MentionRef[]): Map<string, ChipMention> {
  return new Map(
    mentions.map((mention) => [
      `${mention.kind}:${mention.actorId.toLowerCase()}`,
      { handle: mention.handle, agentId: mention.kind === "agent" ? mention.actorId : undefined },
    ]),
  );
}

/**
 * Replaces resolved mention tokens with chips in an already-sanitized tree, skipping anything
 * inside `code` or `pre`. A mention is a reference, not a link, so a chip is a plain `span`
 * with no interaction — membership and wake rules live on the server.
 */
export function rehypeMentionChips(options: {
  handles: Map<string, ChipMention>;
  viewerHandle?: string;
}) {
  const { handles, viewerHandle } = options;
  const tokenPattern = new RegExp(MENTION_TOKEN_PATTERN.source, "gi");

  return (tree: Root) => {
    const visit = (node: Root | Element, inCode: boolean) => {
      const tagName = node.type === "element" ? node.tagName : undefined;
      const code = inCode || tagName === "code" || tagName === "pre";
      const next: Array<Element | Text> = [];

      for (const child of node.children as Array<Element | Text>) {
        if (child.type === "text" && !code && child.value.includes("<@")) {
          const parts = chipParts(child.value, tokenPattern, handles, viewerHandle);
          if (parts) {
            next.push(...parts);
            continue;
          }
        }
        if (child.type === "element") visit(child, code);
        next.push(child);
      }

      node.children = next;
    };

    visit(tree, false);
  };
}

/** The chip/text replacement for one text node, or `undefined` when it holds no token. */
function chipParts(
  value: string,
  tokenPattern: RegExp,
  handles: Map<string, ChipMention>,
  viewerHandle?: string,
): Array<Element | Text> | undefined {
  tokenPattern.lastIndex = 0;
  const parts: Array<Element | Text> = [];
  let offset = 0;
  let matched = false;

  for (const match of value.matchAll(tokenPattern)) {
    matched = true;
    const kind = match[1]!.toLowerCase() === "human" ? "user" : "agent";
    const mention = handles.get(`${kind}:${match[2]!.toLowerCase()}`);
    if (match.index > offset) parts.push({ type: "text", value: value.slice(offset, match.index) });
    if (mention === undefined) {
      // An unresolvable token stays as written rather than becoming a phantom highlight.
      parts.push({ type: "text", value: match[0] });
    } else {
      const self = Boolean(viewerHandle) && mention.handle === viewerHandle;
      const className = (self ? MENTION_CHIP_SELF_CLASS : MENTION_CHIP_CLASS).split(" ");
      // An Agent chip is clickable: it carries its Agent id and the recognisable class the
      // renderer turns into a button. A human chip stays a plain reference (no profile panel).
      if (mention.agentId) className.push(MENTION_CHIP_AGENT_CLASS);
      parts.push({
        type: "element",
        tagName: "span",
        properties: {
          className,
          ...(mention.agentId ? { "data-mention-agent-id": mention.agentId } : {}),
        },
        children: [{ type: "text", value: `@${mention.handle}` }],
      });
    }
    offset = match.index + match[0].length;
  }

  if (!matched) return undefined;
  if (offset < value.length) parts.push({ type: "text", value: value.slice(offset) });
  return parts;
}
