/**
 * The one send-time recognizer of a message body's references. It reads the Markdown syntax tree
 * the renderer reads — the same dialect (`parseMessageSyntax`) over the same input
 * (`escapeLiteralHtml(body)`) — so only what the renderer shows as prose is ever a reference:
 * nothing under code, a code block, a link (a GFM autolink included), a link reference, a
 * definition or HTML is read.
 *
 * Each prose `text` node is read left to right against one ordered set of alternatives:
 *
 * 1. a mention, `@handle` (`MENTION_PATTERN`);
 * 2. a thread reference, `#name:shortid` (`THREAD_REFERENCE_PATTERN`) — kept as text for now;
 * 3. a task reference, `task #N` (`TASK_REFERENCE_PATTERN`);
 * 4. a channel reference, `#name` (`CHANNEL_REFERENCE_PATTERN`).
 *
 * The earliest match wins, and at the same position the earlier alternative wins. A match is
 * consumed whether or not it resolves, which is what gives each reference its precedence: a thread
 * reference's `#name` is never also a channel, and the `#N` of `task #N` is never also a channel.
 *
 * What resolves becomes its stored token, spliced into the body as written at the node's source
 * offsets (mapped back through the escaping), so every byte outside a replaced reference stays
 * identical. A match whose source is not exactly its text — an escaped `\#name`, a character
 * reference — is written literally, not referenced.
 *
 * Resolution is two steps because the server's lookups are queries: `readMessageReferences` reads
 * the body once and lists its `candidates`, the caller looks those up, and `resolve` rewrites the
 * body with the answers. The token grammar and the readers live in the SDK.
 */
import {
  CHANNEL_REFERENCE_PATTERN,
  MENTION_PATTERN,
  TASK_REFERENCE_PATTERN,
  THREAD_REFERENCE_PATTERN,
  channelReferenceToken,
  mentionToken,
  taskReferenceToken,
} from "@lrm/coforge-sdk/internal";
import type { Nodes, Text } from "mdast";

import { escapeLiteralHtml, parseMessageSyntax } from "./message-syntax";

type Reference =
  | { kind: "mention"; handle: string }
  | { kind: "thread" }
  | { kind: "task"; number: number }
  | { kind: "channel"; name: string };

/** The alternatives in precedence order. Each reads its own match into a `Reference`. */
const ALTERNATIVES: readonly { pattern: RegExp; read: (match: RegExpExecArray) => Reference }[] = [
  { pattern: MENTION_PATTERN, read: (match) => ({ kind: "mention", handle: match[1]! }) },
  { pattern: THREAD_REFERENCE_PATTERN, read: () => ({ kind: "thread" }) },
  {
    pattern: TASK_REFERENCE_PATTERN,
    read: (match) => ({ kind: "task", number: Number(match[1]) }),
  },
  {
    pattern: CHANNEL_REFERENCE_PATTERN,
    // Channel names are stored lower-case, so a reference matches regardless of case.
    read: (match) => ({ kind: "channel", name: match[1]!.toLowerCase() }),
  },
];

/** Syntax whose text is never prose: code, links and their definitions, and raw HTML. */
const NOT_PROSE = new Set<Nodes["type"]>([
  "code",
  "inlineCode",
  "link",
  "linkReference",
  "definition",
  "html",
]);

/** What a body's prose could refer to, deduped in first-seen order. */
export type MessageReferenceCandidates = {
  /** Every `@handle`, for resolving against the conversation's mention targets. */
  handles: string[];
  /** Every `task #N` number, for checking against the conversation's tasks. */
  taskNumbers: number[];
  /** Every `#name`, lower-cased, for checking against the Workspace's channels. */
  channelNames: string[];
};

/** How a caller answers the candidates. An absent lookup resolves nothing of its kind. */
export type MessageReferenceLookup = {
  mention?: (handle: string) => { type: "user" | "agent"; id: string } | undefined;
  task?: (number: number) => boolean;
  channel?: (name: string) => { id: string; name: string } | undefined;
};

/** A body's references, read once: what they could mean, and the rewrite once they are answered. */
export type MessageReferences = {
  candidates: MessageReferenceCandidates;
  /**
   * The body with every reference `lookup` resolves rewritten into its stored token —
   * `<@human|agent:uuid>`, `<@task:N>`, `<@channel:uuid:name>` — and every other byte as written.
   */
  resolve: (lookup: MessageReferenceLookup) => string;
};

/** Reads a body's prose references once, for the caller to look up and then resolve. */
export function readMessageReferences(body: string): MessageReferences {
  const references = proseReferences(body);
  const handles = new Set<string>();
  const taskNumbers = new Set<number>();
  const channelNames = new Set<string>();
  for (const { reference } of references) {
    if (reference.kind === "mention") handles.add(reference.handle);
    else if (reference.kind === "task") taskNumbers.add(reference.number);
    else if (reference.kind === "channel") channelNames.add(reference.name);
  }
  return {
    candidates: {
      handles: [...handles],
      taskNumbers: [...taskNumbers],
      channelNames: [...channelNames],
    },
    resolve: (lookup) => {
      let result = "";
      let cursor = 0;
      for (const { reference, start, end } of references) {
        const token = tokenFor(reference, lookup);
        if (token === undefined) continue;
        result += body.slice(cursor, start) + token;
        cursor = end;
      }
      return result + body.slice(cursor);
    },
  };
}

function tokenFor(reference: Reference, lookup: MessageReferenceLookup): string | undefined {
  switch (reference.kind) {
    case "mention": {
      const target = lookup.mention?.(reference.handle);
      return target && mentionToken(target.type, target.id);
    }
    case "thread":
      return undefined;
    case "task":
      return lookup.task?.(reference.number) ? taskReferenceToken(reference.number) : undefined;
    case "channel": {
      const channel = lookup.channel?.(reference.name);
      return channel && channelReferenceToken(channel.id, channel.name);
    }
  }
}

/** Every reference in the body's prose, in reading order, with its offsets in `body`. */
function proseReferences(body: string): { reference: Reference; start: number; end: number }[] {
  const source = escapeLiteralHtml(body);
  const toBody = bodyOffsets(body, source);
  const references: { reference: Reference; start: number; end: number }[] = [];
  for (const node of proseTextNodes(parseMessageSyntax(source))) {
    const offsets = sourceOffsets(source, node);
    if (!offsets) continue;
    for (const match of matchesIn(node.value)) {
      const from = offsets.start[match.index]!;
      const to = offsets.end[match.index + match.text.length - 1]!;
      // Written exactly as matched: an escape or a character reference inside it means the
      // author wrote the characters literally.
      if (source.slice(from, to) !== match.text) continue;
      // Reference text holds no `<`, so it maps back to the body one character for one.
      const start = toBody[from]!;
      references.push({ reference: match.reference, start, end: start + match.text.length });
    }
  }
  return references;
}

/**
 * The body offset of each offset of its Markdown source. `escapeLiteralHtml` only ever turns a
 * `<` into `&lt;`, so the two differ exactly there: each of those four source characters maps to
 * the body's `<`.
 */
function bodyOffsets(body: string, source: string): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (let index = 0; index < source.length;) {
    if (body[at] === "<" && source.startsWith("&lt;", index)) {
      offsets.push(at, at, at, at);
      index += 4;
    } else {
      offsets.push(at);
      index += 1;
    }
    at += 1;
  }
  offsets.push(at);
  return offsets;
}

/** The prose `text` nodes of a tree, in document order. */
function proseTextNodes(tree: Nodes): Text[] {
  if (tree.type === "text") return [tree];
  if (NOT_PROSE.has(tree.type) || !("children" in tree)) return [];
  return tree.children.flatMap((child) => proseTextNodes(child));
}

/**
 * Where each character of a text node's value was written in `source`: `start[i]` is the source
 * offset where value character `i` begins (the `\` of an escape, the `&` of a character
 * reference) and `end[i]` the offset right after it. Whitespace the parser dropped (a continuation
 * line's indent) belongs to no character. `undefined` when the node has no position or its source
 * cannot be aligned with its value; the node is then left as written.
 */
function sourceOffsets(source: string, node: Text): { start: number[]; end: number[] } | undefined {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if (from === undefined || to === undefined) return undefined;
  const { value } = node;
  const start: number[] = [];
  const end: number[] = [];
  let offset = from;
  for (let index = 0; index < value.length;) {
    if (offset >= to) return undefined;
    const reference = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/.exec(
      source.slice(offset, Math.min(to, offset + 40)),
    );
    // An unknown name (`&nope;`) is not a character reference and stays literal in the value.
    if (reference && value.startsWith(reference[0], index)) {
      start[index] = offset;
      end[index] = offset + 1;
      index += 1;
      offset += 1;
    } else if (reference) {
      // A character reference decodes to one character: two UTF-16 units for an astral one.
      const units = isHighSurrogate(value.charCodeAt(index)) ? 2 : 1;
      for (let unit = 0; unit < units; unit += 1) {
        start[index + unit] = offset;
        end[index + unit] = offset + reference[0].length;
      }
      index += units;
      offset += reference[0].length;
    } else if (source[offset] === value[index]) {
      start[index] = offset;
      end[index] = offset + 1;
      index += 1;
      offset += 1;
    } else if (source[offset] === "\\" && source[offset + 1] === value[index]) {
      start[index] = offset;
      end[index] = offset + 2;
      index += 1;
      offset += 2;
    } else if (/\s/.test(source[offset]!)) {
      offset += 1;
    } else {
      return undefined;
    }
  }
  return { start, end };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * The references in one run of prose, in reading order. Each alternative keeps its next match until
 * the cursor passes it, so a long text is scanned once per alternative.
 */
function matchesIn(text: string): { reference: Reference; index: number; text: string }[] {
  // Fresh instances: `exec` with `lastIndex` is stateful.
  const patterns = ALTERNATIVES.map(({ pattern }) => new RegExp(pattern.source, pattern.flags));
  const upcoming: (RegExpExecArray | null | undefined)[] = patterns.map(() => undefined);
  const matches: { reference: Reference; index: number; text: string }[] = [];
  let cursor = 0;
  for (;;) {
    let best = -1;
    for (const [index, pattern] of patterns.entries()) {
      const pending = upcoming[index];
      if (pending === undefined || (pending !== null && pending.index < cursor)) {
        pattern.lastIndex = cursor;
        upcoming[index] = pattern.exec(text);
      }
      const match = upcoming[index];
      if (match && (best === -1 || match.index < upcoming[best]!.index)) best = index;
    }
    if (best === -1) return matches;
    const match = upcoming[best]!;
    matches.push({
      reference: ALTERNATIVES[best]!.read(match),
      index: match.index,
      text: match[0],
    });
    cursor = match.index + match[0].length;
  }
}
