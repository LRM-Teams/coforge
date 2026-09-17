import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronUp,
  Copy01,
  Download01,
  Expand01,
  Minimize01,
  ParagraphWrap,
  SearchLg,
  XClose,
} from "@untitledui/icons";
import { ToggleButton as AriaToggleButton } from "react-aria-components";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { styles as buttonStyles } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Tooltip } from "@/components/base/tooltip/tooltip";
import { ContentEditor } from "@/features/records/report-editor/content-editor";
import { copyText } from "@/features/records/report-editor/lib/clipboard";
import { sharedLowlight } from "@/features/records/report-editor/lowlight";
import { formatFileSize, getFileExtension } from "@/features/records/report-editor/utils/file-meta";
import { extensionToLanguage } from "@/features/records/report-editor/utils/preview";
import "@/features/records/report-editor/styles/code.css";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { findMatches, FIND_MATCH_CAP, type FindMatch } from "./find-in-text";
import { splitHighlightedLines, type HastRoot } from "./split-highlighted-lines";
import "./project-file-view.css";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

// Lines render every row into the DOM (no JS virtualization) so the
// browser's native find-in-page, select-all and copy keep working over the
// whole file; `content-visibility: auto` on each chunk is what keeps that
// affordable by skipping layout/paint for off-screen chunks.
const CHUNK_SIZE = 200;
const LINE_HEIGHT_PX = 20;

// Highlighting a huge file with lowlight is slow (it's a full tokenizer
// pass); past this size, render escaped plain text instead of blocking the
// main thread on a file nobody was going to read token-by-token anyway.
const MAX_HIGHLIGHT_CHARS = 512_000;

const WRAP_STORAGE_KEY = "coforge-file-wrap";
const FIND_DEBOUNCE_MS = 120;
const FIND_HIGHLIGHT = "pfv-find";
const FIND_ACTIVE_HIGHLIGHT = "pfv-find-active";

// Zen mode's fullscreen overlay sits below every existing overlay layer in
// this codebase (Modal, Tooltip, the slim sidebar nav, bubble-menu — all
// z-50) so a tooltip or popover opened while in zen mode still renders above
// it, without relying on DOM/portal paint order to break the tie at an equal
// z-index.
const ZEN_Z_INDEX = "z-40";

const SKELETON_BAR_WIDTHS = [
  "w-11/12",
  "w-2/3",
  "w-4/5",
  "w-1/2",
  "w-3/4",
  "w-5/6",
  "w-1/3",
  "w-2/3",
  "w-4/5",
  "w-1/2",
  "w-3/5",
  "w-2/5",
];

export function ProjectFileView({
  path,
  name,
  byteSize,
  text,
  githubUrl,
  downloadUrl,
}: {
  path: string;
  name: string;
  byteSize: number;
  text: string | null;
  githubUrl: string;
  downloadUrl: string;
}) {
  const isMarkdown = MARKDOWN_EXTENSIONS.has(getFileExtension(name));
  const [tab, setTab] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(readWrapPreference);
  const [zen, setZen] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Find-in-file state. Kept here (not in CodeView) because the toolbar's
  // search button and the keyboard shortcut both live at this level; the
  // matches themselves are computed off the raw `text` prop, independent of
  // highlighting or the DOM.
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const findInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const findSupported = useMemo(() => supportsFindHighlighting(), []);

  useEffect(() => () => clearTimeout(copyTimeoutRef.current), []);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedQuery(query), FIND_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [query]);

  const matches = useMemo(
    () => (text !== null && findOpen ? findMatches(text, debouncedQuery, { caseSensitive }) : []),
    [text, findOpen, debouncedQuery, caseSensitive],
  );

  useEffect(() => {
    setActiveMatchIndex(matches.length > 0 ? 0 : -1);
  }, [matches]);

  useEffect(() => {
    if (findOpen) findInputRef.current?.focus();
  }, [findOpen]);

  const lines = useMemo(() => computeLines(text, name), [text, name]);
  const dir =
    path.length > name.length && path.endsWith(name)
      ? path.slice(0, path.length - name.length)
      : "";
  const sizeLabel = formatFileSize(byteSize);
  const showCode = text !== null && (!isMarkdown || tab === "source");

  async function handleCopy() {
    if (text === null) return;
    if (!(await copyText(text))) return;
    setCopied(true);
    clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
  }

  function openFind() {
    if (text === null) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (isMarkdown && tab === "preview") setTab("source");
    setFindOpen(true);
  }

  function closeFind() {
    setFindOpen(false);
    setQuery("");
    previousFocusRef.current?.focus();
  }

  function goToNextMatch() {
    if (matches.length === 0) return;
    setActiveMatchIndex((index) => (index + 1) % matches.length);
  }

  function goToPreviousMatch() {
    if (matches.length === 0) return;
    setActiveMatchIndex((index) => (index - 1 + matches.length) % matches.length);
  }

  function handleTabChange(next: "preview" | "source") {
    setTab(next);
    if (next === "preview" && findOpen) closeFind();
  }

  function handleRootKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const isFindShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f";
    if (isFindShortcut) {
      // A second Cmd/Ctrl+F while the find bar already has focus falls
      // through to the browser's native find-in-page instead of being
      // hijacked again.
      if (
        findOpen &&
        event.currentTarget.querySelector("[data-find-bar]")?.contains(document.activeElement)
      ) {
        return;
      }
      event.preventDefault();
      openFind();
      return;
    }
    if (event.key === "Escape") {
      // The find bar's Escape takes priority over exiting zen mode.
      if (findOpen) {
        closeFind();
        return;
      }
      if (zen) setZen(false);
    }
  }

  function handleFindKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) goToPreviousMatch();
      else goToNextMatch();
    }
  }

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        zen && `fixed inset-0 ${ZEN_Z_INDEX} bg-primary`,
      )}
      onKeyDown={handleRootKeyDown}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-secondary px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex min-w-0 items-baseline">
            <span className="min-w-0 truncate text-sm text-tertiary">{dir}</span>
            <span className="shrink-0 text-sm font-medium text-primary">{name}</span>
          </span>
          <span className="shrink-0 text-xs text-tertiary tabular-nums">
            {text !== null
              ? `${m.project_file_lines({ count: lines.length })} · ${sizeLabel}`
              : sizeLabel}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isMarkdown && text !== null && (
            <ButtonGroup
              aria-label={m.project_file_preview()}
              size="sm"
              selectedKeys={[tab]}
              disallowEmptySelection
              onSelectionChange={(keys) => {
                const next = [...keys][0];
                if (next === "preview" || next === "source") handleTabChange(next);
              }}
              className="mr-1"
            >
              <ButtonGroupItem id="preview">{m.project_file_preview()}</ButtonGroupItem>
              <ButtonGroupItem id="source">{m.project_file_source()}</ButtonGroupItem>
            </ButtonGroup>
          )}
          {showCode && findSupported && (
            <Tooltip title={m.project_file_find()}>
              <Button
                size="sm"
                color="tertiary"
                aria-label={m.project_file_find()}
                iconLeading={SearchLg}
                onPress={() => (findOpen ? closeFind() : openFind())}
              />
            </Tooltip>
          )}
          {showCode && (
            <Tooltip title={m.project_file_wrap()}>
              <ToolbarToggle
                aria-label={m.project_file_wrap()}
                icon={ParagraphWrap}
                isSelected={wrap}
                onChange={(next) => {
                  setWrap(next);
                  writeWrapPreference(next);
                }}
              />
            </Tooltip>
          )}
          <Tooltip title={zen ? m.project_file_zen_exit() : m.project_file_zen()}>
            <ToolbarToggle
              aria-label={zen ? m.project_file_zen_exit() : m.project_file_zen()}
              icon={zen ? Minimize01 : Expand01}
              isSelected={zen}
              onChange={setZen}
            />
          </Tooltip>
          {text !== null && (
            <Tooltip title={copied ? m.project_file_copied() : m.project_file_copy()}>
              <Button
                size="sm"
                color="tertiary"
                aria-label={copied ? m.project_file_copied() : m.project_file_copy()}
                iconLeading={copied ? Check : Copy01}
                onPress={handleCopy}
              />
            </Tooltip>
          )}
          <Tooltip title={m.project_file_download()}>
            <Button
              size="sm"
              color="tertiary"
              aria-label={m.project_file_download()}
              iconLeading={Download01}
              href={downloadUrl}
              download={name}
            />
          </Tooltip>
          <Tooltip title={m.project_open_on_github()}>
            <Button
              size="sm"
              color="tertiary"
              aria-label={m.project_open_on_github()}
              iconLeading={ArrowUpRight}
              href={githubUrl}
              target="_blank"
              rel="noreferrer"
            />
          </Tooltip>
        </div>
      </div>
      {/* The find bar docks to this frame, not to the scroller, so it stays put while scrolling. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto bg-primary">
          {text === null ? (
            <NotPreviewable githubUrl={githubUrl} downloadUrl={downloadUrl} name={name} />
          ) : isMarkdown && tab === "preview" ? (
            <div className="mx-auto max-w-3xl px-6 py-4">
              <ContentEditor editable={false} defaultValue={text} />
            </div>
          ) : (
            <CodeView
              lines={lines}
              wrap={wrap}
              matches={matches}
              activeMatchIndex={activeMatchIndex}
            />
          )}
        </div>
        {showCode && findOpen && (
          <FindBar
            inputRef={findInputRef}
            query={query}
            onQueryChange={setQuery}
            caseSensitive={caseSensitive}
            onCaseSensitiveChange={setCaseSensitive}
            matchCount={matches.length}
            activeMatchIndex={activeMatchIndex}
            onNext={goToNextMatch}
            onPrevious={goToPreviousMatch}
            onClose={closeFind}
            onKeyDown={handleFindKeyDown}
          />
        )}
      </div>
    </div>
  );
}

export function ProjectFileViewSkeleton({ name }: { name: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true">
      <span className="sr-only">{m.project_tree_loading()}</span>
      <div className="flex items-center gap-2 border-b border-secondary px-4 py-2">
        <span className="min-w-0 truncate text-sm font-medium text-primary">{name}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-hidden px-4 py-4">
        {SKELETON_BAR_WIDTHS.map((width, index) => (
          <div
            key={index}
            className={cn(
              "h-2.5 animate-pulse rounded bg-secondary motion-reduce:animate-none",
              width,
            )}
          />
        ))}
      </div>
    </div>
  );
}

function NotPreviewable({
  githubUrl,
  downloadUrl,
  name,
}: {
  githubUrl: string;
  downloadUrl: string;
  name: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-16 text-center">
      <p className="text-sm text-tertiary">{m.project_file_not_previewable()}</p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          color="secondary"
          href={githubUrl}
          target="_blank"
          rel="noreferrer"
          iconTrailing={ArrowUpRight}
        >
          {m.project_open_on_github()}
        </Button>
        <Button
          size="sm"
          color="secondary"
          href={downloadUrl}
          download={name}
          iconLeading={Download01}
        >
          {m.project_file_download()}
        </Button>
      </div>
    </div>
  );
}

/** A quiet icon toggle matching `Button`'s tertiary icon-only look, styled selected/pressed. */
function ToolbarToggle({
  isSelected,
  onChange,
  icon: Icon,
  "aria-label": ariaLabel,
}: {
  isSelected: boolean;
  onChange: (isSelected: boolean) => void;
  icon: FC<{ className?: string }>;
  "aria-label": string;
}) {
  return (
    <AriaToggleButton
      aria-label={ariaLabel}
      isSelected={isSelected}
      onChange={onChange}
      data-icon-only
      className={cn(
        buttonStyles.common.root,
        buttonStyles.sizes.sm.root,
        buttonStyles.colors.tertiary.root,
        isSelected && "bg-secondary text-primary",
      )}
    >
      <Icon data-icon="leading" className={buttonStyles.common.icon} />
    </AriaToggleButton>
  );
}

function FindBar({
  inputRef,
  query,
  onQueryChange,
  caseSensitive,
  onCaseSensitiveChange,
  matchCount,
  activeMatchIndex,
  onNext,
  onPrevious,
  onClose,
  onKeyDown,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (value: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (value: boolean) => void;
  matchCount: number;
  activeMatchIndex: number;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      data-find-bar
      onKeyDown={onKeyDown}
      className="absolute top-2 right-5 z-20 flex items-center gap-1 rounded-lg border border-secondary bg-primary p-1 shadow-lg"
    >
      <Input
        ref={inputRef}
        size="sm"
        aria-label={m.project_file_find_placeholder()}
        placeholder={m.project_file_find_placeholder()}
        icon={SearchLg}
        value={query}
        onChange={onQueryChange}
        wrapperClassName="w-48"
      />
      <span
        className={cn(
          "shrink-0 px-1 text-xs tabular-nums",
          matchCount === 0 ? "text-tertiary" : "text-secondary",
        )}
      >
        {formatMatchCount(matchCount, activeMatchIndex)}
      </span>
      <Tooltip title={m.project_file_find_previous()}>
        <Button
          size="sm"
          color="tertiary"
          aria-label={m.project_file_find_previous()}
          iconLeading={ChevronUp}
          isDisabled={matchCount === 0}
          onPress={onPrevious}
        />
      </Tooltip>
      <Tooltip title={m.project_file_find_next()}>
        <Button
          size="sm"
          color="tertiary"
          aria-label={m.project_file_find_next()}
          iconLeading={ChevronDown}
          isDisabled={matchCount === 0}
          onPress={onNext}
        />
      </Tooltip>
      <Tooltip title={m.project_file_find_case()}>
        <AriaToggleButton
          aria-label={m.project_file_find_case()}
          isSelected={caseSensitive}
          onChange={onCaseSensitiveChange}
          className={cn(
            buttonStyles.common.root,
            buttonStyles.sizes.sm.root,
            buttonStyles.colors.tertiary.root,
            "px-2 text-xs font-semibold",
            caseSensitive && "bg-secondary text-primary",
          )}
        >
          Aa
        </AriaToggleButton>
      </Tooltip>
      <Tooltip title={m.project_file_find_close()}>
        <Button
          size="sm"
          color="tertiary"
          aria-label={m.project_file_find_close()}
          iconLeading={XClose}
          onPress={onClose}
        />
      </Tooltip>
    </div>
  );
}

function formatMatchCount(count: number, activeIndex: number): string {
  const total = count >= FIND_MATCH_CAP ? `${FIND_MATCH_CAP.toLocaleString()}+` : String(count);
  const current = count === 0 ? 0 : activeIndex + 1;
  return `${current} / ${total}`;
}

function CodeView({
  lines,
  wrap,
  matches,
  activeMatchIndex,
}: {
  lines: string[];
  wrap: boolean;
  matches: FindMatch[];
  activeMatchIndex: number;
}) {
  const chunkRefs = useRef<Array<HTMLDivElement | null>>([]);
  const chunks = useMemo(() => {
    const result: string[][] = [];
    for (let i = 0; i < lines.length; i += CHUNK_SIZE) result.push(lines.slice(i, i + CHUNK_SIZE));
    return result;
  }, [lines]);
  const gutterWidth = `${String(lines.length).length}ch`;

  // The full set of matches is rebuilt only when the match list itself
  // changes (not on every next/prev navigation) — `matches` is memoised by
  // the parent, so this stays cheap even while the user is just stepping
  // through results.
  useEffect(() => {
    if (!supportsFindHighlighting()) return;
    if (matches.length === 0) {
      CSS.highlights.delete(FIND_HIGHLIGHT);
      return;
    }
    const ranges: Range[] = [];
    for (const match of matches) {
      const range = rangeForMatch(chunkRefs.current, match);
      if (range) ranges.push(range);
    }
    if (ranges.length > 0) CSS.highlights.set(FIND_HIGHLIGHT, new Highlight(...ranges));
    else CSS.highlights.delete(FIND_HIGHLIGHT);
    return () => {
      CSS.highlights.delete(FIND_HIGHLIGHT);
    };
  }, [matches]);

  useEffect(() => {
    if (!supportsFindHighlighting()) return;
    const match = matches[activeMatchIndex];
    if (!match) {
      CSS.highlights.delete(FIND_ACTIVE_HIGHLIGHT);
      return;
    }
    const chunkEl = chunkRefs.current[Math.floor((match.line - 1) / CHUNK_SIZE)];
    const found = chunkEl ? findRow(chunkEl, match.line) : null;
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
  }, [matches, activeMatchIndex]);

  useEffect(
    () => () => {
      if (!supportsFindHighlighting()) return;
      CSS.highlights.delete(FIND_HIGHLIGHT);
      CSS.highlights.delete(FIND_ACTIVE_HIGHLIGHT);
    },
    [],
  );

  return (
    <div
      // `rich-text-editor` scopes the shared `.hljs-*` token color rules
      // from report-editor's code.css. Deliberately no `<code>` element
      // anywhere below — `.rich-text-editor code` carries inline-code
      // border/background/padding that would otherwise bleed into every line.
      className="pfv-code-root rich-text-editor relative min-h-full min-w-full py-2 font-mono text-[13px] leading-5 tab-4"
      data-wrap={wrap ? "on" : "off"}
      style={{ "--pfv-gutter-w": gutterWidth } as CSSProperties}
    >
      {chunks.map((chunkLines, chunkIndex) => (
        <div
          key={chunkIndex}
          ref={(el) => {
            chunkRefs.current[chunkIndex] = el;
          }}
          style={{
            contentVisibility: "auto",
            containIntrinsicSize: `auto ${chunkLines.length * LINE_HEIGHT_PX}px`,
          }}
          // Built once per chunk and set as raw HTML: at file scale, building
          // per-line React elements is the expensive part virtualization
          // would normally avoid — this keeps that cost out of the DOM diff.
          dangerouslySetInnerHTML={{
            __html: renderChunkHtml(chunkLines, chunkIndex * CHUNK_SIZE),
          }}
        />
      ))}
    </div>
  );
}

function renderChunkHtml(chunkLines: string[], startIndex: number): string {
  let html = "";
  for (let i = 0; i < chunkLines.length; i++) {
    const lineNumber = startIndex + i + 1;
    html +=
      `<div class="pfv-row flex w-max min-w-full gap-4">` +
      // `data-line` + the CSS `::before` in project-file-view.css keep the
      // number out of find-in-page and out of a copy/select-all of the code.
      `<span class="pfv-lineno sticky left-0 z-10 shrink-0 select-none border-r border-secondary bg-primary pr-3 text-right text-quaternary" data-line="${lineNumber}"></span>` +
      `<span class="pfv-code">${chunkLines[i]}</span>` +
      `</div>`;
  }
  return html;
}

function computeLines(text: string | null, name: string): string[] {
  if (text === null) return [];
  const language = MARKDOWN_EXTENSIONS.has(getFileExtension(name))
    ? "markdown"
    : extensionToLanguage(name);
  return splitHighlightedLines(highlight(text, language));
}

function highlight(text: string, language: string | undefined): HastRoot {
  const canHighlight =
    Boolean(language) && sharedLowlight.registered(language!) && text.length <= MAX_HIGHLIGHT_CHARS;
  if (canHighlight) {
    try {
      return sharedLowlight.highlight(language!, text);
    } catch {
      // Fall through to the plain-text tree below.
    }
  }
  return { type: "root", children: [{ type: "text", value: text }] };
}

function readWrapPreference(): boolean {
  try {
    return localStorage.getItem(WRAP_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function writeWrapPreference(wrap: boolean) {
  try {
    localStorage.setItem(WRAP_STORAGE_KEY, wrap ? "on" : "off");
  } catch {
    // Private mode or blocked storage: the choice still holds for this visit.
  }
}

function supportsFindHighlighting(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof Highlight !== "undefined" &&
    typeof CSS !== "undefined" &&
    Boolean(CSS.highlights)
  );
}

/** Finds the `.pfv-row`/`.pfv-code` pair for a line, scoped to one chunk (never `document`-wide). */
function findRow(
  chunkEl: HTMLElement,
  line: number,
): { row: HTMLElement; code: HTMLElement } | null {
  const lineNoEl = chunkEl.querySelector(`[data-line="${line}"]`);
  const row = lineNoEl?.parentElement;
  const code = row?.querySelector<HTMLElement>(".pfv-code");
  if (row instanceof HTMLElement && code) return { row, code };
  return null;
}

function rangeForMatch(chunkEls: Array<HTMLDivElement | null>, match: FindMatch): Range | null {
  const chunkEl = chunkEls[Math.floor((match.line - 1) / CHUNK_SIZE)];
  if (!chunkEl) return null;
  const found = findRow(chunkEl, match.line);
  if (!found) return null;
  return buildRangeForMatch(found.code, match.start, match.end);
}

/**
 * Maps a (start, end) character offset within a row's plain text back onto a
 * DOM `Range`, by walking the row's text nodes (which may be split across
 * several highlighting `<span>`s — a match can straddle a token boundary,
 * and `Range` endpoints don't need to share a text node).
 */
function buildRangeForMatch(codeEl: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    const length = text.data.length;
    if (startNode === null && offset + length >= start) {
      startNode = text;
      startOffset = start - offset;
    }
    if (offset + length >= end) {
      endNode = text;
      endOffset = end - offset;
      break;
    }
    offset += length;
  }
  if (!startNode || !endNode) return null;
  const range = new Range();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}
