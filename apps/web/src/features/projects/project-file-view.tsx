import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
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
import { useKeyboard } from "react-aria";
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
import { FIND_MATCH_CAP } from "./find-in-text";
import { splitHighlightedLines, type HastRoot } from "./split-highlighted-lines";
import { useFindInFile } from "./use-find-in-file";
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
  /** Omitted for entries with no meaningful size (symlinks, submodules). */
  byteSize?: number;
  text: string | null;
  githubUrl: string;
  /** Omitted for entries that can't be downloaded (symlinks, submodules). */
  downloadUrl?: string;
}) {
  const isMarkdown = MARKDOWN_EXTENSIONS.has(getFileExtension(name));
  const [tab, setTab] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(readWrapPreference);
  const [zen, setZen] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const codeRootRef = useRef<HTMLDivElement>(null);
  const zenButtonRef = useRef<HTMLButtonElement>(null);

  const lines = useMemo(() => computeLines(text, name), [text, name]);
  const showCode = text !== null && (!isMarkdown || tab === "source");

  // Find-in-file state (query, matches, active index, the CSS Custom
  // Highlight API registration) lives in this hook; tabs, copy, wrap and zen
  // stay here since they're specific to this component's toolbar.
  const find = useFindInFile({ text, codeRootRef, enabled: showCode });

  useEffect(() => () => clearTimeout(copyTimeoutRef.current), []);

  const dir =
    path.length > name.length && path.endsWith(name)
      ? path.slice(0, path.length - name.length)
      : "";
  const sizeLabel = byteSize !== undefined ? formatFileSize(byteSize) : undefined;
  const metaText = [text !== null ? m.project_file_lines({ count: lines.length }) : null, sizeLabel]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  async function handleCopy() {
    if (text === null) return;
    if (!(await copyText(text))) return;
    setCopied(true);
    clearTimeout(copyTimeoutRef.current);
    copyTimeoutRef.current = setTimeout(() => setCopied(false), 1500);
  }

  function openFind() {
    if (isMarkdown && tab === "preview") setTab("source");
    find.open();
  }

  function handleTabChange(next: "preview" | "source") {
    setTab(next);
    if (next === "preview" && find.findOpen) find.close();
  }

  // Entering zen moves focus into the pane so it's immediately
  // keyboard-scrollable; leaving it returns focus to the control that
  // toggles it, regardless of whether zen was exited by clicking the
  // toggle, pressing Escape with focus in the view, or pressing Escape with
  // focus on `<body>` (see the document-level listener below).
  const setZenMode = useCallback((next: boolean) => {
    setZen(next);
    if (next) scrollerRef.current?.focus();
    else zenButtonRef.current?.focus();
  }, []);

  // Escape and Cmd/Ctrl+F while focus is anywhere inside this view (the
  // toolbar, the find bar, or the now-focusable code scroller).
  const { keyboardProps } = useKeyboard({
    onKeyDown(event) {
      const isFindShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f";
      if (isFindShortcut) {
        if (!find.findSupported) {
          // The Highlight API this feature depends on isn't available:
          // never intercept the shortcut, let the browser's native find run.
          event.continuePropagation();
          return;
        }
        const findBarHasFocus =
          find.findOpen &&
          Boolean(
            rootRef.current?.querySelector("[data-find-bar]")?.contains(document.activeElement),
          );
        if (findBarHasFocus) {
          // A second Cmd/Ctrl+F while the find bar already has focus falls
          // through to the browser's native find-in-page instead of being
          // hijacked again.
          event.continuePropagation();
          return;
        }
        event.preventDefault();
        openFind();
        return;
      }
      if (event.key === "Escape" && find.findOpen) {
        // The find bar's Escape takes priority over exiting zen mode.
        find.close();
        return;
      }
      if (event.key === "Escape" && zen) {
        setZenMode(false);
        return;
      }
      event.continuePropagation();
    },
  });

  // While zen is on, the view is a full-screen layer and focus may land on
  // `<body>` (e.g. after clicking non-focusable code text before the
  // scroller existed, or a browser chrome interaction) where the keyboard
  // handler above — attached to a descendant of the root — never sees the
  // keydown, since it never bubbles into this subtree. This listens at the
  // document level, only while zen is actually on, to catch that case too.
  const findRef = useRef(find);
  findRef.current = find;
  useEffect(() => {
    if (!zen) return;
    function onDocumentKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (findRef.current.findOpen) {
        findRef.current.close();
        return;
      }
      setZenMode(false);
    }
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, [zen, setZenMode]);

  function handleFindKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) find.previous();
      else find.next();
    }
  }

  return (
    <div
      ref={rootRef}
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        zen && `fixed inset-0 ${ZEN_Z_INDEX} bg-primary`,
      )}
      {...keyboardProps}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-secondary px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex min-w-0 items-baseline">
            <span className="min-w-0 truncate text-sm text-tertiary">{dir}</span>
            <span className="shrink-0 text-sm font-medium text-primary">{name}</span>
          </span>
          {metaText !== "" && (
            <span className="shrink-0 text-xs text-tertiary tabular-nums">{metaText}</span>
          )}
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
          {showCode && find.findSupported && (
            <Tooltip title={m.project_file_find()}>
              <Button
                size="sm"
                color="tertiary"
                aria-label={m.project_file_find()}
                iconLeading={SearchLg}
                onPress={() => (find.findOpen ? find.close() : openFind())}
              />
            </Tooltip>
          )}
          {showCode && (
            <Tooltip title={m.project_file_wrap()}>
              <ToolbarToggle
                aria-label={m.project_file_wrap()}
                isSelected={wrap}
                onChange={(next) => {
                  setWrap(next);
                  writeWrapPreference(next);
                }}
              >
                <ParagraphWrap data-icon="leading" className={buttonStyles.common.icon} />
              </ToolbarToggle>
            </Tooltip>
          )}
          <Tooltip title={zen ? m.project_file_zen_exit() : m.project_file_zen()}>
            <ToolbarToggle
              ref={zenButtonRef}
              aria-label={zen ? m.project_file_zen_exit() : m.project_file_zen()}
              isSelected={zen}
              onChange={setZenMode}
            >
              {zen ? (
                <Minimize01 data-icon="leading" className={buttonStyles.common.icon} />
              ) : (
                <Expand01 data-icon="leading" className={buttonStyles.common.icon} />
              )}
            </ToolbarToggle>
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
          {downloadUrl !== undefined && (
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
          )}
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
        <div
          ref={scrollerRef}
          tabIndex={0}
          role="region"
          aria-label={name}
          className="min-h-0 flex-1 overflow-auto bg-primary outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          {text === null ? (
            <NotPreviewable githubUrl={githubUrl} downloadUrl={downloadUrl} name={name} />
          ) : isMarkdown && tab === "preview" ? (
            <div className="mx-auto max-w-3xl px-6 py-4">
              <ContentEditor editable={false} defaultValue={text} />
            </div>
          ) : (
            <CodeView lines={lines} wrap={wrap} codeRootRef={codeRootRef} />
          )}
        </div>
        {showCode && find.findOpen && (
          <FindBar
            inputRef={find.inputRef}
            query={find.query}
            onQueryChange={find.setQuery}
            caseSensitive={find.caseSensitive}
            onCaseSensitiveChange={find.setCaseSensitive}
            matchCount={find.matches.length}
            activeMatchIndex={find.activeMatchIndex}
            onNext={find.next}
            onPrevious={find.previous}
            onClose={find.close}
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
  downloadUrl?: string;
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
        {downloadUrl !== undefined && (
          <Button
            size="sm"
            color="secondary"
            href={downloadUrl}
            download={name}
            iconLeading={Download01}
          >
            {m.project_file_download()}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * A quiet icon (or, with `iconOnly={false}`, text) toggle matching `Button`'s
 * tertiary look, styled selected/pressed. Shared by the toolbar's
 * wrap/zen toggles and the find bar's "Aa" case-sensitivity toggle so the
 * pressed/hover styling lives in one place.
 */
const ToolbarToggle = forwardRef<
  HTMLButtonElement,
  {
    isSelected: boolean;
    onChange: (isSelected: boolean) => void;
    "aria-label": string;
    className?: string;
    /** @default true */
    iconOnly?: boolean;
    children: ReactNode;
  }
>(function ToolbarToggle(
  { isSelected, onChange, "aria-label": ariaLabel, className, iconOnly = true, children },
  ref,
) {
  return (
    <AriaToggleButton
      ref={ref}
      aria-label={ariaLabel}
      isSelected={isSelected}
      onChange={onChange}
      data-icon-only={iconOnly ? true : undefined}
      className={cn(
        buttonStyles.common.root,
        buttonStyles.sizes.sm.root,
        buttonStyles.colors.tertiary.root,
        isSelected && "bg-secondary text-primary",
        className,
      )}
    >
      {children}
    </AriaToggleButton>
  );
});

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
  inputRef: RefObject<HTMLInputElement | null>;
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
        <ToolbarToggle
          aria-label={m.project_file_find_case()}
          isSelected={caseSensitive}
          onChange={onCaseSensitiveChange}
          iconOnly={false}
          className="px-2 text-xs font-semibold"
        >
          Aa
        </ToolbarToggle>
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
  codeRootRef,
}: {
  lines: string[];
  wrap: boolean;
  codeRootRef: RefObject<HTMLDivElement | null>;
}) {
  const chunks = useMemo(() => {
    const result: string[][] = [];
    for (let i = 0; i < lines.length; i += CHUNK_SIZE) result.push(lines.slice(i, i + CHUNK_SIZE));
    return result;
  }, [lines]);
  const gutterWidth = `${String(lines.length).length}ch`;

  return (
    <div
      ref={codeRootRef}
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
