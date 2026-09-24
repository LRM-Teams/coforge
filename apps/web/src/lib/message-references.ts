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
 * 2. a thread reference, `#name:shortid` (`THREAD_REFERENCE_PATTERN`): one top-level message of
 *    that channel, named by a unique 6–8 hex prefix of its id or by the whole id;
 * 3. a task reference, `task #N` (`TASK_REFERENCE_PATTERN`);
 * 4. a bare `#N` (`BARE_TASK_REFERENCE_PATTERN`): one of the conversation's tasks, otherwise a
 *    channel of that name;
 * 5. a channel reference, `#name` (`CHANNEL_REFERENCE_PATTERN`).
 *
 * The earliest match wins, and at the same position the earlier alternative wins. A match is
 * consumed whether or not it resolves, which is what gives each reference its precedence: a thread
 * reference's `#name` is never also a channel, and the `#N` of `task #N` is never also a channel.
 * A bare `#N` therefore carries its own fall-through: it is read with the whole `#name` run it
 * starts, and resolves to the task N, else the channel that run names. When the run is longer than
 * the number (`#132-plan`), a channel with that whole name comes first, so a channel name that
 * starts with digits still reads whole; failing that, the number is still the task. Only the
 * channel reading needs the whole run written exactly: in `#5-\_b\_` the escapes rule out a
 * channel, but the `#5` is written exactly and is still the task.
 *
 * An unresolved thread reference — no such channel, no such message, or a prefix two messages
 * share — stays text as a whole: its `#name` is consumed with it and never read as a channel.
 *
 * What resolves becomes its stored token, spliced into the body as written at the node's source
 * offsets (mapped back through the escaping), so every byte outside a replaced reference stays
 * identical. A match whose source is not exactly its text — an escaped `\#name`, a character
 * reference — is written literally, not referenced (except a bare `#N` whose number is written
 * exactly, above).
 *
 * A token already in the body is not special here: like a mention token, it is a claim that every
 * consumer checks against authoritative data (the renderer links a channel token only when the
 * viewer's channel list has its id, opens a thread token's thread only under that same check, and
 * chips a task token only for a task of the conversation).
 *
 * Resolution is two steps because the server's lookups are queries: `readMessageReferences` reads
 * the body once and lists its `candidates`, the caller looks those up, and `resolve` rewrites the
 * body with the answers. The token grammar and the readers live in the SDK.
 */
import {
  BARE_TASK_REFERENCE_PATTERN,
  CHANNEL_NAME_PATTERN,
  CHANNEL_REFERENCE_PATTERN,
  MENTION_PATTERN,
  TASK_REFERENCE_PATTERN,
  THREAD_REFERENCE_PATTERN,
  channelReferenceToken,
  mentionToken,
  taskReferenceToken,
  threadReferenceToken,
} from "@lrm/coforge-sdk/internal";
import { decodeNamedCharacterReference } from "decode-named-character-reference";
import type { Nodes, Text } from "mdast";
import { decodeNumericCharacterReference } from "micromark-util-decode-numeric-character-reference";

import { escapeLiteralHtml, parseMessageSyntax } from "./message-syntax";

type Reference =
  | { kind: "mention"; handle: string }
  /** `name` is the channel name, `anchor` the message id or prefix, both lower-cased. */
  | { kind: "thread"; name: string; anchor: string }
  | { kind: "task"; number: number }
  /** A bare `#N`: `name` is the whole `#name` run it starts, lower-cased, and `rest` what that run
   * holds after the number, as written (empty when the run is just the number). */
  | { kind: "bareNumber"; number: number; name: string; rest: string }
  | { kind: "channel"; name: string };

/**
 * One alternative's reading of its match: the reference, and the text it consumes. `exactPart` is
 * what a prefix of that text still reads as when the whole is not written exactly but the prefix
 * is (see `proseReferences`).
 */
type Reading = { reference: Reference; text: string; exactPart?: Omit<Reading, "exactPart"> };

/** The `#name` run a channel reference reads, anchored where a bare `#N` starts. */
const CHANNEL_RUN = new RegExp(CHANNEL_REFERENCE_PATTERN.source, "uy");

/** The alternatives in precedence order. Each reads its own match into a `Reading`. */
const ALTERNATIVES: readonly { pattern: RegExp; read: (match: RegExpExecArray) => Reading }[] = [
  {
    pattern: MENTION_PATTERN,
    read: (match) => ({ reference: { kind: "mention", handle: match[1]! }, text: match[0] }),
  },
  {
    pattern: THREAD_REFERENCE_PATTERN,
    // Channel names are stored lower-case and message ids are lower-case hex.
    read: (match) => ({
      reference: {
        kind: "thread",
        name: match[1]!.toLowerCase(),
        anchor: match[2]!.toLowerCase(),
      },
      text: match[0],
    }),
  },
  {
    pattern: TASK_REFERENCE_PATTERN,
    read: (match) => ({ reference: { kind: "task", number: Number(match[1]) }, text: match[0] }),
  },
  { pattern: BARE_TASK_REFERENCE_PATTERN, read: readBareNumber },
  {
    pattern: CHANNEL_REFERENCE_PATTERN,
    // Channel names are stored lower-case, so a reference matches regardless of case.
    read: (match) => ({
      reference: { kind: "channel", name: match[1]!.toLowerCase() },
      text: match[0],
    }),
  },
];

/** A bare `#N`, read with the whole `#name` run it starts, so it can fall through to a channel. */
function readBareNumber(match: RegExpExecArray): Reading {
  CHANNEL_RUN.lastIndex = match.index;
  // The run always matches here: a bare `#N` is itself a `#name` run.
  const run = CHANNEL_RUN.exec(match.input)![0];
  const number = Number(match[1]);
  return {
    reference: {
      kind: "bareNumber",
      number,
      name: run.slice(1).toLowerCase(),
      rest: run.slice(match[0].length),
    },
    text: run,
    // Only the channel reading needs the whole run: the number alone is still the task.
    exactPart:
      run.length > match[0].length
        ? { reference: { kind: "task", number }, text: match[0] }
        : undefined,
  };
}

/**
 * One private scanner per alternative, created once. `exec` with `lastIndex` is stateful, so the
 * SDK's shared pattern constants are never scanned with directly; `matchesIn` sets `lastIndex`
 * before every `exec`.
 */
const SCANNERS = ALTERNATIVES.map(({ pattern }) => new RegExp(pattern.source, pattern.flags));

/** A character reference in Markdown source (`&amp;`, `&#35;`, `&#x23;`), tried only at `&`. */
const CHARACTER_REFERENCE =
  /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/y;

/** ASCII punctuation: what a backslash escapes in Markdown. */
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

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
type MessageReferenceCandidates = {
  /** Every `@handle`, for resolving against the conversation's mention targets. */
  handles: string[];
  /** Every `task #N` and bare `#N` number, for checking against the conversation's tasks. */
  taskNumbers: number[];
  /** Every `#name` that could be a channel's name (`CHANNEL_NAME_PATTERN`), lower-cased, for
   * checking against the Workspace's channels. */
  channelNames: string[];
  /** Every `#name:shortid` whose name a channel could be called, both lower-cased, for finding the
   * message among that channel's top-level messages. */
  threads: { name: string; anchor: string }[];
};

/** How a caller answers the candidates. An absent lookup resolves nothing of its kind. */
export type MessageReferenceLookup = {
  mention?: (handle: string) => { type: "user" | "agent"; id: string } | undefined;
  task?: (number: number) => boolean;
  channel?: (name: string) => { id: string; name: string } | undefined;
  /** The one top-level message of the channel called `name` that `anchor` (a 6–8 hex prefix of its
   * id, or the whole id) names; `undefined` when there is none, or more than one. */
  thread?: (
    name: string,
    anchor: string,
  ) => { channelId: string; rootId: string; name: string } | undefined;
};

/** A body's references, read once: what they could mean, and the rewrite once they are answered. */
export type MessageReferences = {
  candidates: MessageReferenceCandidates;
  /**
   * The body with every reference `lookup` resolves rewritten into its stored token —
   * `<@human|agent:uuid>`, `<@task:N>`, `<@channel:uuid:name>`, `<@thread:uuid:uuid:name>` — and
   * every other byte as written.
   */
  resolve: (lookup: MessageReferenceLookup) => string;
};

/** Reads a body's prose references once, for the caller to look up and then resolve. */
export function readMessageReferences(body: string): MessageReferences {
  const references = proseReferences(body);
  const handles = new Set<string>();
  const taskNumbers = new Set<number>();
  const channelNames = new Set<string>();
  const threads = new Map<string, { name: string; anchor: string }>();
  for (const { reference } of references) {
    if (reference.kind === "mention") handles.add(reference.handle);
    else if (reference.kind === "task") taskNumbers.add(reference.number);
    else if (reference.kind === "bareNumber") {
      taskNumbers.add(reference.number);
      if (CHANNEL_NAME_PATTERN.test(reference.name)) channelNames.add(reference.name);
    } else if (reference.kind === "channel" && CHANNEL_NAME_PATTERN.test(reference.name))
      channelNames.add(reference.name);
    else if (reference.kind === "thread" && CHANNEL_NAME_PATTERN.test(reference.name))
      threads.set(`${reference.name}:${reference.anchor}`, {
        name: reference.name,
        anchor: reference.anchor,
      });
  }
  return {
    candidates: {
      handles: [...handles],
      taskNumbers: [...taskNumbers],
      channelNames: [...channelNames],
      threads: [...threads.values()],
    },
    resolve: (lookup) => {
      if (references.length === 0) return body;
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
    case "thread": {
      const thread = lookup.thread?.(reference.name, reference.anchor);
      return thread && threadReferenceToken(thread.channelId, thread.rootId, thread.name);
    }
    case "task":
      return lookup.task?.(reference.number) ? taskReferenceToken(reference.number) : undefined;
    case "bareNumber": {
      const task = lookup.task?.(reference.number);
      const channel = lookup.channel?.(reference.name);
      // The task comes first, except against a channel named by a run longer than the number.
      if (channel && (reference.rest || !task))
        return channelReferenceToken(channel.id, channel.name);
      return task ? taskReferenceToken(reference.number) + reference.rest : undefined;
    }
    case "channel": {
      const channel = lookup.channel?.(reference.name);
      return channel && channelReferenceToken(channel.id, channel.name);
    }
  }
}

/** Every reference in the body's prose, in reading order, with its offsets in `body`. */
function proseReferences(body: string): { reference: Reference; start: number; end: number }[] {
  // Every reference starts with a literal `@` or `#` (`task #N` included): without one there is
  // nothing to parse for.
  if (!body.includes("@") && !body.includes("#")) return [];
  const source = escapeLiteralHtml(body);
  const toBody = source === body ? undefined : bodyOffsets(body, source);
  const references: { reference: Reference; start: number; end: number }[] = [];
  // Where the last aligned text ended: a text node with no position is looked for after it.
  let cursor = 0;
  for (const { node, within } of proseTextNodes(parseMessageSyntax(source), undefined)) {
    const matches = matchesIn(node.value);
    if (matches.length === 0) {
      // Only a node that holds a match is aligned; a positioned one still moves the cursor on.
      cursor = node.position?.end.offset ?? cursor;
      continue;
    }
    const aligned = alignNode(source, node, within, cursor);
    if (!aligned) continue;
    cursor = aligned.end;
    for (const match of matches) {
      const from = aligned.starts[match.index]!;
      // Written exactly as matched: an escape or a character reference inside it means the
      // author wrote the characters literally. A reading whose exact prefix still means something
      // (a bare `#N` whose run goes on) falls back to that prefix.
      const exact = [match, match.exactPart].find(
        (reading) => reading !== undefined && source.startsWith(reading.text, from),
      );
      if (!exact) continue;
      // Reference text holds no `<`, so it maps back to the body one character for one.
      const start = toBody ? toBody[from]! : from;
      references.push({ reference: exact.reference, start, end: start + exact.text.length });
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

type SourceRange = { start: number; end: number };

/**
 * The prose `text` nodes of a tree, in document order, each with the source range of its nearest
 * positioned ancestor. GFM's autolink-literal transform splits text around a bare URL or email
 * address into new nodes that carry no position; such a node is found inside that range.
 */
function proseTextNodes(
  tree: Nodes,
  within: SourceRange | undefined,
): { node: Text; within: SourceRange | undefined }[] {
  const start = tree.position?.start.offset;
  const end = tree.position?.end.offset;
  const range = start !== undefined && end !== undefined ? { start, end } : within;
  if (tree.type === "text") return [{ node: tree, within }];
  if (NOT_PROSE.has(tree.type) || !("children" in tree)) return [];
  return tree.children.flatMap((child) => proseTextNodes(child, range));
}

/**
 * Where a text node's characters were written in `source`, and where it ends. A positioned node
 * is aligned from its own start; a node with no position at the first offset, from `cursor` on
 * inside its ancestor's range, where its whole value aligns. `undefined` when it cannot be
 * aligned; its references are then left as written.
 */
function alignNode(
  source: string,
  node: Text,
  within: SourceRange | undefined,
  cursor: number,
): { starts: number[]; end: number } | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start !== undefined && end !== undefined) return sourceStarts(source, node.value, start, end);
  if (!within) return undefined;
  for (let from = Math.max(cursor, within.start); from < within.end; from += 1) {
    const aligned = sourceStarts(source, node.value, from, within.end);
    if (aligned) return aligned;
  }
  return undefined;
}

/**
 * Where each character of `value` begins in `source`, aligned from `from` and within `to`: the
 * character itself, the `\` of an escape, or the `&` of a character reference; and the offset
 * after the last one.
 *
 * What the parser dropped belongs to no character: whitespace (a line's trailing spaces) and, at
 * the start of a continuation line, its indentation and container markers — a quote's `>`
 * (nested, indented, inside a list item). A list item's continuation lines carry only indentation
 * and a table cell never spans lines, so a quote marker is the only non-whitespace syntax a
 * continuation line drops. How much of a line's leading `>`/whitespace run is syntax is decided per
 * line: the shortest prefix after which the whole line aligns.
 */
function sourceStarts(
  source: string,
  value: string,
  from: number,
  to: number,
): { starts: number[]; end: number } | undefined {
  const starts: number[] = [];
  let offset = from;
  let index = 0;
  while (index < value.length) {
    // One line of the value at a time: its prefix, then its characters up to its line ending.
    const lineEnd = value.indexOf("\n", index);
    const last = lineEnd === -1 ? value.length : lineEnd + 1;
    let aligned: number | undefined;
    if (index === 0) aligned = alignLine(source, offset, to, value, index, last, starts);
    else {
      let prefix = offset;
      while (prefix < to && /[ \t>]/.test(source[prefix]!)) prefix += 1;
      for (let start = offset; start <= prefix && aligned === undefined; start += 1)
        aligned = alignLine(source, start, to, value, index, last, starts);
    }
    if (aligned === undefined) return undefined;
    offset = aligned;
    index = last;
  }
  return { starts, end: offset };
}

/**
 * Aligns value characters `[index, last)` from source offset `offset`, recording where each
 * begins; the source offset after the last one, or `undefined` when they do not align.
 */
function alignLine(
  source: string,
  offset: number,
  to: number,
  value: string,
  index: number,
  last: number,
  starts: number[],
): number | undefined {
  while (index < last) {
    if (offset >= to) return undefined;
    const character = source[offset]!;
    const reference = character === "&" ? characterReferenceAt(source, offset, to) : undefined;
    if (reference && value.startsWith(reference.decoded, index)) {
      for (let unit = 0; unit < reference.decoded.length; unit += 1) starts[index + unit] = offset;
      index += reference.decoded.length;
      offset += reference.text.length;
    } else if (
      character === "\\" &&
      ASCII_PUNCTUATION.test(source[offset + 1] ?? "") &&
      source[offset + 1] === value[index]
    ) {
      // A backslash escape: the pair is one character of the value.
      starts[index] = offset;
      index += 1;
      offset += 2;
    } else if (character === value[index]) {
      starts[index] = offset;
      index += 1;
      offset += 1;
    } else if (/\s/.test(character)) {
      offset += 1;
    } else {
      return undefined;
    }
  }
  return offset;
}

/**
 * The character reference written at `offset` and what it decodes to, when one ends by `to` —
 * decoded with the parser's own decoders, so a reference that decodes to several characters
 * aligns exactly. An unknown name (`&nope;`) is not a reference.
 */
function characterReferenceAt(
  source: string,
  offset: number,
  to: number,
): { text: string; decoded: string } | undefined {
  CHARACTER_REFERENCE.lastIndex = offset;
  const match = CHARACTER_REFERENCE.exec(source);
  if (!match || offset + match[0].length > to) return undefined;
  const decoded =
    match[1] !== undefined
      ? decodeNumericCharacterReference(match[1], 10)
      : match[2] !== undefined
        ? decodeNumericCharacterReference(match[2], 16)
        : decodeNamedCharacterReference(match[3]!);
  return decoded === false ? undefined : { text: match[0], decoded };
}

/**
 * The references in one run of prose, in reading order. Each alternative keeps its next match until
 * the cursor passes it, so a long text is scanned once per alternative.
 */
function matchesIn(text: string): (Reading & { index: number })[] {
  const upcoming: (RegExpExecArray | null | undefined)[] = SCANNERS.map(() => undefined);
  const matches: (Reading & { index: number })[] = [];
  let cursor = 0;
  for (;;) {
    let best = -1;
    for (const [index, pattern] of SCANNERS.entries()) {
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
    const reading = ALTERNATIVES[best]!.read(match);
    matches.push({ ...reading, index: match.index });
    cursor = match.index + reading.text.length;
  }
}
