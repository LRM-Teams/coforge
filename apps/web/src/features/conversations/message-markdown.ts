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
 * 2. A stored `<@kind:…>` token (a mention, a task, a channel or a thread) still renders as its chip, and
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
  TASK_REFERENCE_TOKEN_PATTERN,
  THREAD_REFERENCE_TOKEN_PATTERN,
  threadReferenceText,
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
/** The chip's `className` list, split once; nothing mutates it. */
const CHANNEL_CHIP_CLASSES = CHANNEL_CHIP_CLASS.split(" ");

/**
 * Thread-reference chip classes. A `<@thread:uuid:uuid:name>` token renders with the same soft fill;
 * the renderer turns the chip into a link that opens the thread in its channel (see
 * `message-body.tsx`).
 */
export const THREAD_CHIP_CLASS =
  "message-markdown-thread-reference rounded-sm px-0.5 font-medium bg-brand-primary text-brand-secondary";
const THREAD_CHIP_CLASSES = THREAD_CHIP_CLASS.split(" ");

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

/** Where a text node sits: code keeps its text as written, and inside a link nothing becomes a
 * chip. That is one consistency rule for every kind, not only the chips a renderer turns into a
 * control: a link reads as the text it shows and keeps pointing where its author aimed it. */
type Place = "prose" | "link";

/** What a chip pass knows about the viewer and the conversation, each the authority for one kind. */
type ReferenceChipOptions = {
  /** The message's mention rows, keyed the way `mentionHandlesByToken` keys them. */
  mentions: Map<string, ChipMention>;
  viewerHandle?: string;
  /** Plain-`@handle` display resolution: every conversation member's handle → chip. */
  plainMentions?: Map<string, ChipMention>;
  /** The conversation's own task numbers. */
  taskNumbers?: ReadonlySet<number>;
  /** Every channel of the Workspace, id → current name, for a view that can navigate: the authority
   * for channel and thread tokens alike. */
  channelNames?: ReadonlyMap<string, string>;
};

/** One kind of reference: its pattern, and what one match becomes in a given place —
 * `undefined` when the match is no reference and stays as written. */
type ReferenceKind = {
  pattern: RegExp;
  build: (groups: readonly string[], place: Place) => Element | Text | undefined;
};

/**
 * Replaces every reference in an already-sanitized tree with its chip, in one pass. Every chip comes
 * from a stored `<@kind:…>` token, and each token is a claim checked against its own authority:
 *
 * - a mention token (`<@human|agent:uuid>`) against the message's mention rows (`mentions`): a
 *   token with no row stays as written rather than becoming a phantom highlight. The chip shows the
 *   member's display label; an Agent chip carries its id (`data-mention-agent-id`) so the renderer
 *   can open its profile. A mention is a reference, not a link — wake rules live on the server;
 * - a task token (`<@task:68>`) against the conversation's tasks (`taskNumbers`): a listed number is
 *   a **number-only** chip (`#68`, `title`/`aria-label` "task #68") carrying
 *   `data-task-reference-number` for the renderer to make a control; any other number reads as the
 *   text `task #N`;
 * - a channel token (`<@channel:uuid:name>`) against the Workspace's channels (`channelNames`, closed
 *   and archived ones included): a listed id is a chip under the channel's current name, carrying
 *   `data-channel-id` for the renderer to make a link; any other id — unknown, deleted or forged —
 *   reads as the plain `#name` it stored. Without `channelNames` (a view that is itself one link,
 *   such as a Saved card) every channel token reads as plain `#name`;
 * - a thread token (`<@thread:uuid:uuid:name>`) against the same channels: a listed channel id is a
 *   chip `#name:<8 hex>` under the channel's current name, carrying `data-thread-channel-id` and
 *   `data-thread-root-id` for the renderer to make a link that opens the thread; any other reads as
 *   the plain `#name:<8 hex>` it stored. Whether the root message still exists is the thread
 *   opener's to say: the chip claims only the channel.
 *
 * `plainMentions` additionally chips a *plain* `@handle` (a DM body, or a channel body whose author
 * never used the completion) that names a conversation member exactly, with that member's display
 * label. Display-only: the stored body and the wake rules are unchanged, and an unknown handle, an
 * email address or `@@` stays literal text (`MENTION_PATTERN`).
 *
 * Every pattern is matched in one scan of each text node, so a chip's own label (an Agent called
 * "Scout #5") is finished markup that is never read again. Code (`code`, `pre`) keeps its text as
 * written; inside a link (`a`) every token reads as its text and nothing becomes a chip, whatever
 * its kind (see `Place`).
 */
export function rehypeReferenceChips(options: ReferenceChipOptions) {
  const kinds = referenceKinds(options);
  const { pattern, read } = patternAlternation(kinds.map((kind) => kind.pattern));
  const plain = options.plainMentions !== undefined && options.plainMentions.size > 0;

  /** The replacement for one text node, or `undefined` when nothing in it is a reference. */
  const parts = (value: string, place: Place): Array<Element | Text> | undefined => {
    const result: Array<Element | Text> = [];
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
      const { index: kind, groups } = read(match);
      const built = kinds[kind]!.build(groups, place);
      if (built === undefined) continue;
      if (match.index > offset)
        result.push({ type: "text", value: value.slice(offset, match.index) });
      result.push(built);
      offset = match.index + match[0].length;
    }
    if (result.length === 0) return undefined;
    if (offset < value.length) result.push({ type: "text", value: value.slice(offset) });
    return result;
  };

  return (tree: Root) => {
    const visit = (node: Root | Element, place: Place) => {
      const next: Array<Element | Text> = [];
      let changed = false;
      for (const child of node.children as Array<Element | Text>) {
        if (child.type === "element") {
          if (child.tagName !== "code" && child.tagName !== "pre")
            visit(child, child.tagName === "a" ? "link" : place);
        } else if (
          child.type === "text" &&
          (child.value.includes("<@") || (plain && child.value.includes("@")))
        ) {
          const replaced = parts(child.value, place);
          if (replaced) {
            next.push(...replaced);
            changed = true;
            continue;
          }
        }
        next.push(child);
      }
      if (changed) node.children = next;
    };

    visit(tree, "prose");
  };
}

/**
 * Several patterns as one alternation, matched in one scan: at each position the first listed
 * pattern that matches there wins. `read` names which pattern a match came from, by its index, and
 * that pattern's own capture groups.
 *
 * The alternation is one pattern, so it has one set of flags: `g` and every flag of every pattern.
 * A pattern that needs `u` (a `\p{…}` class) brings `u`, and every source is then read in `u` mode;
 * a case-insensitive pattern makes the whole alternation case-insensitive, so a case-sensitive
 * pattern alongside it also matches other cases, and its reader must tell them apart.
 */
export function patternAlternation(patterns: readonly RegExp[]): {
  pattern: RegExp;
  read: (match: RegExpMatchArray) => { index: number; groups: string[] };
} {
  const flags = [...new Set(["g", ...patterns.flatMap((each) => [...each.flags])])]
    .filter((flag) => flag !== "y")
    .join("");
  // Each pattern's own capture groups, counted under the alternation's flags, follow its one
  // wrapping group.
  const groupCounts = patterns.map(
    (each) => new RegExp(`${each.source}|`, flags).exec("")!.length - 1,
  );
  const pattern = new RegExp(patterns.map((each) => `(${each.source})`).join("|"), flags);
  return {
    pattern,
    read: (match) => {
      // The pattern whose wrapping group matched, and its own groups after it.
      let group = 1;
      let index = 0;
      while (match[group] === undefined) group += 1 + groupCounts[index++]!;
      return { index, groups: match.slice(group + 1, group + 1 + groupCounts[index]!) as string[] };
    },
  };
}

/** The kinds a pass matches, each with its chip builder, the plain `@handle` only when asked for. */
function referenceKinds(options: ReferenceChipOptions): ReferenceKind[] {
  const { mentions, viewerHandle, plainMentions, taskNumbers, channelNames } = options;
  const kinds: ReferenceKind[] = [
    {
      pattern: MENTION_TOKEN_PATTERN,
      build: ([kind, id], place) => {
        const mention = mentions.get(
          `${kind!.toLowerCase() === "human" ? "user" : "agent"}:${id!.toLowerCase()}`,
        );
        // A token with no mention row stays as written rather than becoming a phantom highlight.
        if (!mention) return undefined;
        // Inside a link every kind reads as its text (see `Place`), a mention included.
        return place === "link"
          ? { type: "text", value: `@${mention.label}` }
          : mentionChip(mention, viewerHandle);
      },
    },
    {
      pattern: TASK_REFERENCE_TOKEN_PATTERN,
      build: ([digits], place) => {
        const number = Number(digits);
        return place === "prose" && taskNumbers?.has(number)
          ? taskChip(number)
          : { type: "text", value: `task #${number}` };
      },
    },
    {
      pattern: CHANNEL_REFERENCE_TOKEN_PATTERN,
      build: ([rawId, stored], place) => {
        const id = rawId!.toLowerCase();
        const current = channelNames?.get(id);
        // Inside a link the token reads as text under the channel's current name when the
        // Workspace still has it, the name its chip would show, and only otherwise under the
        // name it stored. That is intended: a renamed channel reads the same in and out of a link.
        return place === "prose" && current !== undefined
          ? channelChip(id, current)
          : { type: "text", value: `#${current ?? stored!}` };
      },
    },
    {
      pattern: THREAD_REFERENCE_TOKEN_PATTERN,
      build: ([rawChannelId, rawRootId, stored], place) => {
        const channelId = rawChannelId!.toLowerCase();
        const rootId = rawRootId!.toLowerCase();
        const current = channelNames?.get(channelId);
        // The channel token's rule: under the current name when the Workspace still has the
        // channel, in a link and out of one.
        return place === "prose" && current !== undefined
          ? threadChip(channelId, rootId, current)
          : { type: "text", value: threadReferenceText(current ?? stored!, rootId) };
      },
    },
  ];
  if (plainMentions && plainMentions.size > 0)
    kinds.push({
      pattern: MENTION_PATTERN,
      // The token patterns make the alternation case-insensitive (`patternAlternation`), so it also
      // matches `@Bob`, which `MENTION_PATTERN` alone would not. The lookup is exact-case against
      // lower-case handles, so such a match finds no member and stays as written: the kind keeps
      // its own lower-case rule.
      build: ([handle], place) => {
        const mention = plainMentions.get(handle!);
        return mention && place === "prose" ? mentionChip(mention, viewerHandle) : undefined;
      },
    });
  return kinds;
}

/** A mention chip: the self treatment for the viewer, and an Agent chip the renderer can open. */
function mentionChip(mention: ChipMention, viewerHandle: string | undefined): Element {
  const self = Boolean(viewerHandle) && mention.handle === viewerHandle;
  const className = (self ? MENTION_CHIP_SELF_CLASS : MENTION_CHIP_CLASS).split(" ");
  // A human chip stays a plain reference: there is no human profile panel to open.
  if (mention.agentId) className.push(MENTION_CHIP_AGENT_CLASS);
  return {
    type: "element",
    tagName: "span",
    properties: {
      className,
      ...(mention.agentId ? { "data-mention-agent-id": mention.agentId } : {}),
    },
    children: [{ type: "text", value: `@${mention.label}` }],
  };
}

/** A task chip: only the number is shown; the words stay on the hover and the accessible name, so
 * "#68" still reads as a task reference. */
function taskChip(number: number): Element {
  return {
    type: "element",
    tagName: "span",
    properties: {
      className: [...TASK_CHIP_CLASS.split(" "), TASK_CHIP_LINK_CLASS],
      title: `task #${number}`,
      "aria-label": `task #${number}`,
      "data-task-reference-number": number,
    },
    children: [{ type: "text", value: `#${number}` }],
  };
}

/** A channel chip under the channel's current name. */
function channelChip(id: string, name: string): Element {
  return {
    type: "element",
    tagName: "span",
    properties: { className: CHANNEL_CHIP_CLASSES, "data-channel-id": id },
    children: [{ type: "text", value: `#${name}` }],
  };
}

/** A thread chip, `#name:<8 hex>` under the channel's current name. */
function threadChip(channelId: string, rootId: string, name: string): Element {
  return {
    type: "element",
    tagName: "span",
    properties: {
      className: THREAD_CHIP_CLASSES,
      "data-thread-channel-id": channelId,
      "data-thread-root-id": rootId,
    },
    children: [{ type: "text", value: threadReferenceText(name, rootId) }],
  };
}
