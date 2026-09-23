/**
 * Markdown source preparation and mention-chip substitution for a message body.
 *
 * A message body is untrusted text — written by a human or an Agent — and until now it
 * rendered as literal text. Two existing behaviors must survive the move to Markdown rendering:
 *
 * 1. Raw HTML stays literal. `react-markdown` drops HTML by default, which would silently
 *    delete a body such as `<div>x</div>` — a data-loss regression, not a safety win. Every
 *    HTML-looking `<` outside code is escaped (`escapeLiteralHtml`, `#src/lib/message-syntax`) so
 *    it renders as the characters the author typed. GFM autolinks (`<https://…>`) and reference
 *    tokens keep their `<`.
 * 2. A stored `<@kind:…>` token (a mention, a task or a channel) still renders as its chip, and
 *    still never inside a code span or fence — the server never stores one there either (its
 *    recognizer reads the same Markdown syntax, `#src/lib/message-syntax`).
 *
 * Chips are injected *after* `rehype-sanitize` runs. The sanitizer strips `className`, and the
 * nodes injected here are trusted — a fixed `span` whose only text is a resolved display label —
 * they need not pass the untrusted-content schema. Nothing sanitizer-relevant is added before
 * it runs.
 */
import {
  CHANNEL_REFERENCE_TOKEN_PATTERN,
  MENTION_PATTERN,
  MENTION_TOKEN_PATTERN,
  BARE_TASK_REFERENCE_PATTERN,
  TASK_REFERENCE_TOKEN_PATTERN,
} from "@lrm/coforge-sdk/internal";
import type { Element, Root, Text } from "hast";

import type { MentionRef } from "./mention-text";

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
 * Task-reference chip classes. A `task #68` reference the server stored as a `<@task:68>` token
 * renders with the same soft fill as a mention chip so a reference reads as a reference; the
 * `-link` variant marks the one the renderer turns into a control (see `message-body.tsx`).
 */
const TASK_CHIP_BASE = "message-markdown-task-reference rounded-sm px-0.5 font-medium";
export const TASK_CHIP_CLASS = `${TASK_CHIP_BASE} bg-brand-primary text-brand-secondary`;
export const TASK_CHIP_LINK_CLASS = "message-markdown-task-reference-link";

/**
 * Channel-reference chip classes. A `<@channel:uuid:name>` token renders with the same soft fill as
 * the other reference chips; the renderer turns the chip into a link to that channel (see
 * `message-body.tsx`).
 */
export const CHANNEL_CHIP_CLASS =
  "message-markdown-channel-reference rounded-sm px-0.5 font-medium bg-brand-primary text-brand-secondary";

/** A resolved mention as a chip needs both its stable handle (identity/self matching) and its
 * display label, plus the Agent id to open its profile panel when applicable. */
export type ChipMention = { handle: string; label: string; agentId?: string };

/**
 * The resolved mention for every token in a body, keyed the way `MENTION_TOKEN_PATTERN`
 * spells the token (`user:<uuid>` / `agent:<uuid>`, lower-cased). Stable handles continue to
 * identify the viewer while current profile labels are rendered. A token with no row here
 * degrades to its raw text rather than a phantom chip. An `agent` mention carries its
 * `actorId` as `agentId` so the chip can open that Agent's profile panel.
 */
export function mentionHandlesByToken(mentions: readonly MentionRef[]): Map<string, ChipMention> {
  return new Map(
    mentions.map((mention) => [
      `${mention.kind}:${mention.actorId.toLowerCase()}`,
      {
        handle: mention.handle,
        label: mention.label,
        agentId: mention.kind === "agent" ? mention.actorId : undefined,
      },
    ]),
  );
}

/**
 * Replaces resolved mention tokens with chips in an already-sanitized tree, skipping anything
 * inside `code` or `pre`. A mention is a reference, not a link, so a chip is a plain `span`
 * with no interaction — membership and wake rules live on the server.
 *
 * `plain` additionally chips a body's *plain* `@handle` spellings (no embedded token — a DM
 * body, or a channel body whose author never used the completion): any `@handle` that matches a
 * conversation member's exact handle renders the same chip with that member's display label.
 * Display-only: storage and wake rules are unchanged, and the match reuses the shared
 * `MENTION_PATTERN` grammar (so emails and `@@` never match) against the member directory only —
 * an unknown handle stays literal text.
 */
export function rehypeMentionChips(options: {
  handles: Map<string, ChipMention>;
  viewerHandle?: string;
  plain?: Map<string, ChipMention>;
}) {
  const { handles, viewerHandle, plain } = options;
  const tokenPattern = new RegExp(MENTION_TOKEN_PATTERN.source, "gi");
  const plainPattern =
    plain && plain.size > 0 ? new RegExp(MENTION_PATTERN.source, "g") : undefined;

  return (tree: Root) => {
    const visit = (node: Root | Element, inCode: boolean) => {
      const tagName = node.type === "element" ? node.tagName : undefined;
      const code = inCode || tagName === "code" || tagName === "pre";
      const next: Array<Element | Text> = [];

      for (const child of node.children as Array<Element | Text>) {
        if (child.type === "text" && !code && (child.value.includes("<@") || plainPattern)) {
          const parts = chipParts(
            child.value,
            tokenPattern,
            plainPattern,
            handles,
            plain,
            viewerHandle,
          );
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

/**
 * Replaces stored channel-reference tokens (`<@channel:uuid:name>`) with a chip carrying the
 * channel's id (`data-channel-id`), which the `span` renderer turns into a link to that channel.
 *
 * Every channel is public and readable by every Workspace member, and a token only ever names a
 * channel of the message's own Workspace, so a viewer can always open it: the chip links whenever
 * the host can navigate at all (`currentNames` is given). It shows the channel's current name from
 * `currentNames` and falls back to the name the token stored — a channel the sidebar leaves out
 * (one the viewer closed) still links. Without `currentNames` (a view that is itself one link, such
 * as a Saved card), and inside a link the author wrote, the token reads as plain `#name`. Code
 * keeps its text literal.
 *
 * Runs first among the chip passes, straight after sanitizing: the chip's `#name` is finished
 * markup, and the task pass skips it, so a channel called `132` is never re-read as task #132.
 */
export function rehypeChannelReferenceChips(options: {
  currentNames?: ReadonlyMap<string, string>;
}) {
  const { currentNames } = options;

  return (tree: Root) => {
    const visit = (node: Root | Element, inCode: boolean, inLink: boolean) => {
      const tagName = node.type === "element" ? node.tagName : undefined;
      const code = inCode || tagName === "code" || tagName === "pre";
      const link = inLink || tagName === "a";
      const next: Array<Element | Text> = [];

      for (const child of node.children as Array<Element | Text>) {
        if (child.type === "text" && !code && child.value.includes("<@channel:")) {
          next.push(...channelChipParts(child.value, link ? undefined : currentNames));
          continue;
        }
        if (child.type === "element") visit(child, code, link);
        next.push(child);
      }

      node.children = next;
    };

    visit(tree, false, false);
  };
}

/** The chip/text replacement for one text node: a chip per token when `currentNames` is given,
 * otherwise the token's plain `#name`. */
function channelChipParts(
  value: string,
  currentNames: ReadonlyMap<string, string> | undefined,
): Array<Element | Text> {
  const parts: Array<Element | Text> = [];
  let offset = 0;
  for (const match of value.matchAll(new RegExp(CHANNEL_REFERENCE_TOKEN_PATTERN.source, "gi"))) {
    const id = match[1]!.toLowerCase();
    const label = `#${currentNames?.get(id) ?? match[2]!}`;
    if (match.index > offset) parts.push({ type: "text", value: value.slice(offset, match.index) });
    parts.push(
      currentNames
        ? {
            type: "element",
            tagName: "span",
            properties: { className: CHANNEL_CHIP_CLASS.split(" "), "data-channel-id": id },
            children: [{ type: "text", value: label }],
          }
        : { type: "text", value: label },
    );
    offset = match.index + match[0].length;
  }
  if (offset < value.length) parts.push({ type: "text", value: value.slice(offset) });
  return parts;
}

/**
 * Replaces stored task-reference tokens (`<@task:68>`) with a **number-only** chip (`#68`), skipping
 * anything inside `code` or `pre`. Raft draws the reference as the bare number, so the chip carries
 * the number rather than the prose the author typed; `title`/`aria-label` still spell "task #68" so
 * a hover and a screen reader keep the meaning. Unlike a mention token, a task token always has a
 * readable fallback — the number is the reference — so a token is never left raw. A number present
 * in `numbers` names a task the viewer can open, and its chip carries `data-task-reference-number`
 * for the `span` renderer to turn into a control; any other number renders as plain chip text.
 *
 * A bare `#N` (`BARE_TASK_REFERENCE_PATTERN`) becomes the same chip when N is one of this
 * conversation's tasks, as Raft does: people and Agents write `#132`
 * for a task far more often than `task #132`, and messages sent before the token existed only
 * have the bare form. Any other `#N` — a PR or issue number — stays prose, and so does anything
 * inside code or a link.
 */
export function rehypeTaskReferenceChips(options: { numbers: ReadonlySet<number> }) {
  const { numbers } = options;
  // One pass over each text node: a stored token, or (only when this conversation has tasks) a
  // bare `#N`. `matchAll` clones the regex, so the shared instance never carries `lastIndex`.
  const pattern = new RegExp(
    numbers.size > 0
      ? `${TASK_REFERENCE_TOKEN_PATTERN.source}|${BARE_TASK_REFERENCE_PATTERN.source}`
      : TASK_REFERENCE_TOKEN_PATTERN.source,
    "gi",
  );

  return (tree: Root) => {
    const visit = (node: Root | Element, inSkipped: boolean) => {
      // Code keeps its text literal, a link keeps pointing where its author aimed it, and a mention
      // or channel chip is already a reference: none of them gets a task chip inside.
      const skip =
        inSkipped ||
        (node.type === "element" &&
          (node.tagName === "code" ||
            node.tagName === "pre" ||
            node.tagName === "a" ||
            node.properties["data-mention"] !== undefined ||
            node.properties["data-channel-id"] !== undefined));
      const next: Array<Element | Text> = [];

      for (const child of node.children as Array<Element | Text>) {
        if (
          child.type === "text" &&
          !skip &&
          (child.value.includes("<@task:") || (numbers.size > 0 && child.value.includes("#")))
        ) {
          const parts = taskChipParts(child.value, pattern, numbers);
          if (parts) {
            next.push(...parts);
            continue;
          }
        }
        if (child.type === "element") visit(child, skip);
        next.push(child);
      }

      node.children = next;
    };

    visit(tree, false);
  };
}

/** The chip/text replacement for one text node, or `undefined` when nothing becomes a chip. A
 * stored token (group 1) is always a chip; a bare `#N` (group 2) only when N is a task here. */
function taskChipParts(
  value: string,
  pattern: RegExp,
  numbers: ReadonlySet<number>,
): Array<Element | Text> | undefined {
  const parts: Array<Element | Text> = [];
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    const token = match[1];
    const number = Number(token ?? match[2]);
    if (token === undefined && !numbers.has(number)) continue;
    if (match.index > offset) parts.push({ type: "text", value: value.slice(offset, match.index) });
    const clickable = numbers.has(number);
    const className = TASK_CHIP_CLASS.split(" ");
    if (clickable) className.push(TASK_CHIP_LINK_CLASS);
    parts.push({
      type: "element",
      tagName: "span",
      properties: {
        className,
        // The chip shows only the number (Raft's treatment); the words stay available to a hover
        // and to assistive technology so "#68" is still readable as a task reference.
        title: `task #${number}`,
        "aria-label": `task #${number}`,
        ...(clickable ? { "data-task-reference-number": number } : {}),
      },
      children: [{ type: "text", value: `#${number}` }],
    });
    offset = match.index + match[0].length;
  }
  if (parts.length === 0) return undefined;
  if (offset < value.length) parts.push({ type: "text", value: value.slice(offset) });
  return parts;
}

/** The chip/text replacement for one text node, or `undefined` when nothing matches. */
function chipParts(
  value: string,
  tokenPattern: RegExp,
  plainPattern: RegExp | undefined,
  handles: Map<string, ChipMention>,
  plain: Map<string, ChipMention> | undefined,
  viewerHandle?: string,
): Array<Element | Text> | undefined {
  tokenPattern.lastIndex = 0;
  const parts: Array<Element | Text> = [];
  let offset = 0;
  let matched = false;

  // One merged scan: tokens take precedence (their span covers the whole `<@kind:uuid>` form, so
  // a plain `@agent`-looking prefix inside an unresolved token is never chipped twice), and each
  // plain `@handle` chips only when it names a conversation member exactly.
  const matches: Array<{ index: number; text: string; mention?: ChipMention }> = [];
  for (const match of value.matchAll(tokenPattern)) {
    const kind = match[1]!.toLowerCase() === "human" ? "user" : "agent";
    const mention = handles.get(`${kind}:${match[2]!.toLowerCase()}`);
    matches.push({ index: match.index, text: match[0], mention });
  }
  if (plainPattern && plain && plain.size > 0) {
    for (const match of value.matchAll(plainPattern)) {
      const index = match.index;
      if (matches.some((token) => index >= token.index && index < token.index + token.text.length))
        continue;
      const chip = plain.get(match[1]!);
      if (chip) matches.push({ index, text: match[0], mention: chip });
    }
    matches.sort((a, b) => a.index - b.index);
  }

  for (const match of matches) {
    matched = true;
    const mention = match.mention;
    if (match.index > offset) parts.push({ type: "text", value: value.slice(offset, match.index) });
    if (mention === undefined) {
      // An unresolvable token stays as written rather than becoming a phantom highlight.
      parts.push({ type: "text", value: match.text });
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
          // Marks the chip as finished markup, so the task-reference pass never nests a chip in a
          // display name such as "Scout #5".
          "data-mention": true,
          ...(mention.agentId ? { "data-mention-agent-id": mention.agentId } : {}),
        },
        children: [{ type: "text", value: `@${mention.label}` }],
      });
    }
    offset = match.index + match.text.length;
  }

  if (!matched) return undefined;
  if (offset < value.length) parts.push({ type: "text", value: value.slice(offset) });
  return parts;
}
