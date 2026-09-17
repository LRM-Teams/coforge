import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { findMatches, type FindMatch } from "./find-in-text";
import { planRangeForOffsets } from "./find-range-plan";

const FIND_DEBOUNCE_MS = 120;
const FIND_HIGHLIGHT = "pfv-find";
const FIND_ACTIVE_HIGHLIGHT = "pfv-find-active";

export function supportsFindHighlighting(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof Highlight !== "undefined" &&
    typeof CSS !== "undefined" &&
    Boolean(CSS.highlights)
  );
}

export interface UseFindInFileOptions {
  /** The raw file text `findMatches` searches; `null` when there's nothing to search (no preview). */
  text: string | null;
  /** The `.pfv-code-root` element `data-line` rows are queried from and highlight `Range`s are built against. */
  codeRootRef: RefObject<HTMLDivElement | null>;
  /** Whether the code view (as opposed to markdown preview or the not-previewable panel) is currently rendered. */
  enabled: boolean;
}

export interface UseFindInFile {
  /** Whether the CSS Custom Highlight API this feature depends on exists in this browser. */
  findSupported: boolean;
  findOpen: boolean;
  query: string;
  setQuery: (value: string) => void;
  caseSensitive: boolean;
  setCaseSensitive: (value: boolean) => void;
  matches: FindMatch[];
  activeMatchIndex: number;
  inputRef: RefObject<HTMLInputElement | null>;
  /** No-ops when `findSupported` is false or there's no text to search. */
  open: () => void;
  close: () => void;
  next: () => void;
  previous: () => void;
}

/**
 * Owns the find-in-file state machine for `ProjectFileView`: the query,
 * debounced query, case sensitivity, computed matches, and which one is
 * active, plus registering the matched ranges with the CSS Custom Highlight
 * API and scrolling the active one into view. Pure UI state and DOM
 * side-effects live here; `ProjectFileView` composes this with tabs, copy,
 * wrap and zen, and decides *when* `open()` is reachable (e.g. switching a
 * markdown file to its source tab first).
 */
export function useFindInFile({ text, codeRootRef, enabled }: UseFindInFileOptions): UseFindInFile {
  const findSupported = useMemo(() => supportsFindHighlighting(), []);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedQuery(query), FIND_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [query]);

  const matches = useMemo(
    () =>
      text !== null && enabled && findOpen
        ? findMatches(text, debouncedQuery, { caseSensitive })
        : [],
    [text, enabled, findOpen, debouncedQuery, caseSensitive],
  );

  useEffect(() => {
    setActiveMatchIndex(matches.length > 0 ? 0 : -1);
  }, [matches]);

  useEffect(() => {
    if (findOpen) inputRef.current?.focus();
  }, [findOpen]);

  // The full set of matches is rebuilt only when the match list itself
  // changes (not on every next/prev navigation).
  useEffect(() => {
    if (!findSupported) return;
    const codeRoot = codeRootRef.current;
    if (!codeRoot || matches.length === 0) {
      CSS.highlights.delete(FIND_HIGHLIGHT);
      return;
    }
    const ranges: Range[] = [];
    for (const match of matches) {
      const range = rangeForMatch(codeRoot, match);
      if (range) ranges.push(range);
    }
    if (ranges.length > 0) CSS.highlights.set(FIND_HIGHLIGHT, new Highlight(...ranges));
    else CSS.highlights.delete(FIND_HIGHLIGHT);
    return () => {
      CSS.highlights.delete(FIND_HIGHLIGHT);
    };
  }, [matches, findSupported, codeRootRef]);

  useEffect(() => {
    if (!findSupported) return;
    const codeRoot = codeRootRef.current;
    const match = matches[activeMatchIndex];
    if (!codeRoot || !match) {
      CSS.highlights.delete(FIND_ACTIVE_HIGHLIGHT);
      return;
    }
    const found = findRow(codeRoot, match.line);
    if (!found) {
      CSS.highlights.delete(FIND_ACTIVE_HIGHLIGHT);
      return;
    }
    const range = buildRangeForMatch(found.code, match.start, match.end);
    if (range) CSS.highlights.set(FIND_ACTIVE_HIGHLIGHT, new Highlight(range));
    // `content-visibility: auto` chunks report an estimated intrinsic size
    // until they're actually laid out; scrolling to them can settle at a
    // slightly wrong offset the first time, so nudge again once the browser
    // has had a frame to lay the now-visible chunk out for real.
    found.row.scrollIntoView({ block: "center" });
    const frame = requestAnimationFrame(() => found.row.scrollIntoView({ block: "center" }));
    return () => {
      cancelAnimationFrame(frame);
      CSS.highlights.delete(FIND_ACTIVE_HIGHLIGHT);
    };
  }, [matches, activeMatchIndex, findSupported, codeRootRef]);

  function open() {
    if (!findSupported || text === null) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFindOpen(true);
  }

  function close() {
    setFindOpen(false);
    setQuery("");
    previousFocusRef.current?.focus();
  }

  function next() {
    if (matches.length === 0) return;
    setActiveMatchIndex((index) => (index + 1) % matches.length);
  }

  function previous() {
    if (matches.length === 0) return;
    setActiveMatchIndex((index) => (index - 1 + matches.length) % matches.length);
  }

  return {
    findSupported,
    findOpen,
    query,
    setQuery,
    caseSensitive,
    setCaseSensitive,
    matches,
    activeMatchIndex,
    inputRef,
    open,
    close,
    next,
    previous,
  };
}

/** Finds the `.pfv-row`/`.pfv-code` pair for a line, scoped to the code root (never `document`-wide). */
function findRow(
  codeRoot: HTMLElement,
  line: number,
): { row: HTMLElement; code: HTMLElement } | null {
  const lineNoEl = codeRoot.querySelector(`[data-line="${line}"]`);
  const row = lineNoEl?.parentElement;
  const code = row?.querySelector<HTMLElement>(".pfv-code");
  if (row instanceof HTMLElement && code) return { row, code };
  return null;
}

function rangeForMatch(codeRoot: HTMLElement, match: FindMatch): Range | null {
  const found = findRow(codeRoot, match.line);
  if (!found) return null;
  return buildRangeForMatch(found.code, match.start, match.end);
}

/**
 * Maps a (start, end) character offset within a row's plain text back onto a
 * DOM `Range`, by walking the row's text nodes (which may be split across
 * several highlighting `<span>`s) and handing their lengths to the pure
 * `planRangeForOffsets` to work out which node(s) the offsets land in.
 */
function buildRangeForMatch(codeEl: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) textNodes.push(node as Text);

  const plan = planRangeForOffsets(
    textNodes.map((textNode) => textNode.data.length),
    start,
    end,
  );
  if (!plan) return null;

  const range = new Range();
  range.setStart(textNodes[plan.startSegment], plan.startOffset);
  range.setEnd(textNodes[plan.endSegment], plan.endOffset);
  return range;
}
