/**
 * Pure logic for mentioning people by the name they are shown by, free of React and DOM types.
 *
 * The composer is a plain textarea, so choosing someone from the `@` list writes their readable
 * label (`@张三`) and remembers who was meant: a pin, `{kind, id, handle, label}`, kept with the
 * draft. Sending rewrites each still-intact `@label` to the handle the server resolves
 * (`@zhangsan`) and names the pinned member by id, so the person notified is the one picked even
 * when two people read alike. The readable text stays what the sender sees in their own composer
 * and unsent row; only the request carries the handle.
 *
 * A pin is a claim about text, so it lives only as long as the text does: an `@label` the sender
 * edited into something else, or deleted, sends as typed and binds no one. A name typed by hand,
 * with no pin, can be recognized here too (`unpinnedLabelMentions`) so the composer can ask who was
 * meant. Code is never touched: `splitCodeSpans`, the mention grammar's own code-span split,
 * decides what is prose.
 */
import { splitCodeSpans, type MentionSelectorInput } from "@lrm/coforge-sdk/internal";
import { mentionKey, type Mentionable } from "./mention-text";

/** Who a piece of composer text means, recorded when they were picked from the `@` list. */
export type MentionPin = {
  kind: "user" | "agent";
  id: string;
  /** What the server resolves the mention by; written into the body at send. */
  handle: string;
  /** What the composer shows after the `@`. */
  label: string;
};

/** No pins, as the one array every reset and empty read returns: a state already holding it does
 * not change, so it renders nothing. */
export const NO_PINS: readonly MentionPin[] = [];

/** Whether a value read back from storage is a pin: the one check the saved draft and the unsent
 * message both use. */
export function isMentionPin(value: unknown): value is MentionPin {
  if (!value || typeof value !== "object") return false;
  const pin = value as Record<string, unknown>;
  return (
    (pin.kind === "user" || pin.kind === "agent") &&
    typeof pin.id === "string" &&
    typeof pin.handle === "string" &&
    typeof pin.label === "string"
  );
}

/** What a chosen candidate writes into the draft, before the trailing space. */
export function mentionInsertText(mention: Pick<Mentionable, "label">): string {
  return `@${mention.label}`;
}

export function mentionPinFor(mention: Mentionable): MentionPin {
  return { kind: mention.kind, id: mention.id, handle: mention.handle, label: mention.label };
}

/** The pins with `pin` added. Someone already pinned is pinned once: an unchanged pin returns the
 * same array, a changed one (they were renamed meanwhile) replaces the earlier. */
export function addMentionPin(pins: readonly MentionPin[], pin: MentionPin): readonly MentionPin[] {
  const key = mentionKey(pin);
  const existing = pins.find((each) => mentionKey(each) === key);
  if (existing && existing.handle === pin.handle && existing.label === pin.label) return pins;
  return [...pins.filter((each) => mentionKey(each) !== key), pin];
}

// A mention is a word: the `@` may not be glued to a Latin letter, digit or `_` before it (an email
// address), the same lookbehind the server's `MENTION_PATTERN` applies; CJK text before it is how
// Chinese is typed, so it does not count. What follows the label may not be part of a longer name:
// any letter, digit, combining mark, `_` or `-`, in any script, which is stricter than the server's
// ASCII lookahead because `@张三丰` is not `@张三` followed by a word.
const WORD_BEFORE = /[A-Za-z0-9_@]/;
const WORD_AFTER = /[\p{L}\p{N}\p{M}_-]/u;

type LabelMatch = { start: number; end: number; label: string };

/**
 * Every `@label` of `labels` in the prose of `body`, left to right and never overlapping: where two
 * labels begin alike (`Zhang` and `Zhang San`) the longer takes the text. A match must be a whole
 * word (see `WORD_BEFORE`) outside code and clear of `blocked`.
 */
function findLabelMatches(
  body: string,
  labels: readonly string[],
  blocked: readonly LabelMatch[] = [],
): LabelMatch[] {
  const distinct = [...new Set(labels)].filter(Boolean);
  if (!distinct.length || !body.includes("@")) return [];
  const found: LabelMatch[] = [];
  let offset = 0;
  for (const segment of splitCodeSpans(body)) {
    if (!segment.code) {
      for (const label of distinct) {
        const needle = `@${label}`;
        for (
          let at = segment.text.indexOf(needle);
          at !== -1;
          at = segment.text.indexOf(needle, at + 1)
        ) {
          const end = at + needle.length;
          if (WORD_BEFORE.test(segment.text[at - 1] ?? "")) continue;
          if (WORD_AFTER.test(segment.text[end] ?? "")) continue;
          found.push({ start: offset + at, end: offset + end, label });
        }
      }
    }
    offset += segment.text.length;
  }
  found.sort((left, right) => left.start - right.start || right.end - left.end);
  const chosen: LabelMatch[] = [];
  let lastEnd = 0;
  for (const match of found) {
    if (match.start < lastEnd) continue;
    if (blocked.some((each) => match.start < each.end && each.start < match.end)) continue;
    chosen.push(match);
    lastEnd = match.end;
  }
  return chosen;
}

/**
 * The pin each match stands for. A label one pin owns names that person wherever it appears. A
 * label two or more people share is paired by order (the first `@张三` is the first one picked), which
 * holds only while the text still has exactly as many as were picked; after a deletion or an extra
 * name typed by hand there is no telling which is which, so none of them is claimed.
 */
function pinnedMatches(
  matches: readonly LabelMatch[],
  pins: readonly MentionPin[],
): { match: LabelMatch; pin: MentionPin }[] {
  const pinsByLabel = new Map<string, MentionPin[]>();
  for (const pin of pins) pinsByLabel.set(pin.label, [...(pinsByLabel.get(pin.label) ?? []), pin]);
  const occurrences = new Map<string, number>();
  for (const match of matches)
    occurrences.set(match.label, (occurrences.get(match.label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return matches.flatMap((match) => {
    const owners = pinsByLabel.get(match.label)!;
    if (owners.length === 1) return [{ match, pin: owners[0]! }];
    if (occurrences.get(match.label) !== owners.length) return [];
    const index = seen.get(match.label) ?? 0;
    seen.set(match.label, index + 1);
    return [{ match, pin: owners[index]! }];
  });
}

/** The matches in `body` that the pins claim, each with its pin. */
function pinnedMatchesIn(body: string, pins: readonly MentionPin[]) {
  return pinnedMatches(
    findLabelMatches(
      body,
      pins.map((pin) => pin.label),
    ),
    pins,
  );
}

/**
 * The body a send carries: every still-intact pinned `@label` written as `@handle`, and the members
 * they name as bindings, each once, in the order they first appear. A pin whose `@label` is gone
 * contributes nothing (no binding without a mention in the text).
 */
export function rewriteMentionPins(
  body: string,
  pins: readonly MentionPin[],
): { body: string; mentions: MentionSelectorInput[] } {
  const bound = new Map<string, MentionSelectorInput>();
  let rewritten = "";
  let cursor = 0;
  for (const { match, pin } of pinnedMatchesIn(body, pins)) {
    rewritten += `${body.slice(cursor, match.start)}@${pin.handle}`;
    cursor = match.end;
    const key = mentionKey(pin);
    if (!bound.has(key)) bound.set(key, { type: pin.kind, id: pin.id, name: pin.handle });
  }
  return { body: rewritten + body.slice(cursor), mentions: [...bound.values()] };
}

/**
 * The pins whose `@label` is still in `body` as a mention: what a message needs to keep, and what
 * the draft keeps as it is edited, so a deleted name no longer claims text typed later. Returns
 * `pins` itself when every one is still there and `NO_PINS` when none is, so a state already
 * holding the answer does not change.
 */
export function pinsInText(body: string, pins: readonly MentionPin[]): readonly MentionPin[] {
  if (!pins.length) return NO_PINS;
  const used = new Set(pinnedMatchesIn(body, pins).map(({ pin }) => mentionKey(pin)));
  if (used.size === pins.length) return pins;
  if (!used.size) return NO_PINS;
  return pins.filter((pin) => used.has(mentionKey(pin)));
}

/**
 * The candidates a name typed by hand can mean, by the label they are shown by: each person once
 * (a member and an outsider list may briefly hold the same one), and never one whose label is their
 * own handle, since typing that already names them. Built once per candidate list, not per
 * keystroke.
 */
export function mentionsByLabel(candidates: readonly Mentionable[]): Map<string, Mentionable[]> {
  const byLabel = new Map<string, Mentionable[]>();
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = mentionKey(candidate);
    if (candidate.label === candidate.handle || seen.has(key)) continue;
    seen.add(key);
    const same = byLabel.get(candidate.label);
    if (same) same.push(candidate);
    else byLabel.set(candidate.label, [candidate]);
  }
  return byLabel;
}

/**
 * The names typed by hand that match members but were never picked: `@张三` in the prose, not
 * claimed by a pin, for a candidate shown by that label (`mentionsByLabel`). Returned in the order
 * they first appear, each label once, with every candidate that shares it.
 */
export function unpinnedLabelMentions(
  body: string,
  pins: readonly MentionPin[],
  byLabel: ReadonlyMap<string, readonly Mentionable[]>,
): { label: string; candidates: readonly Mentionable[] }[] {
  // Every keystroke asks; most drafts hold no `@` at all.
  if (!byLabel.size || !body.includes("@")) return [];
  const claimed = pinnedMatchesIn(body, pins).map(({ match }) => match);
  const labels = new Set(findLabelMatches(body, [...byLabel.keys()], claimed).map((m) => m.label));
  return [...labels].map((label) => ({ label, candidates: byLabel.get(label)! }));
}
