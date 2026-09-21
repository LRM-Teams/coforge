import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Copy01,
  Eye,
  EyeOff,
  File02,
  Folder,
  RefreshCw01,
} from "@untitledui/icons";
import {
  Button as AriaButton,
  Collection,
  Tree,
  TreeItem,
  TreeItemContent,
} from "react-aria-components";
import type {
  AgentWorkspaceFileEntry,
  AgentWorkspaceFileReadResult,
  AgentWorkspaceFilesListResult,
} from "@lrm/coforge-sdk/internal";

import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { useResizeObserver } from "@/hooks/use-resize-observer";
import { copyText } from "@/features/records/report-editor/lib/clipboard";
import { ProjectFileView, ProjectFileViewSkeleton } from "@/features/projects/project-file-view";
import { m } from "@/paraglide/messages";
import { cn } from "@/lib/utils";
import { SECTION_CAPTION_CLASS } from "./inline-edit-field";

/** The container width, in CSS px, at and above which the tree and the open file split
 * side-by-side (the wide Members-page pane). Below it, the file replaces the tree and a
 * breadcrumb + back button return to it (the panel's own narrow width) — a single breakpoint,
 * simpler than a true three-way responsive layout and acceptable per the brief. */
const SPLIT_BREAKPOINT_PX = 900;

export type AgentWorkspaceFilesLoadResult =
  | { status: "ready"; result: AgentWorkspaceFilesListResult }
  | { status: "offline" | "timeout" | "unavailable" };
export type AgentWorkspaceFileLoadResult =
  | { status: "ready"; result: AgentWorkspaceFileReadResult }
  | { status: "offline" | "timeout" | "unavailable" };

type DirState =
  | { status: "loading" }
  | { status: "ready"; entries: AgentWorkspaceFileEntry[]; rootPath?: string }
  | { status: "offline" | "timeout" | "unavailable" | "missing" | "unreadable" | "error" };

type FileState =
  | { status: "loading"; path: string }
  | { status: "ready"; path: string; result: AgentWorkspaceFileReadResult }
  | {
      status:
        | "offline"
        | "timeout"
        | "unavailable"
        | "missing"
        | "unreadable"
        | "binary"
        | "too_large"
        | "error";
      path: string;
    };

function hiddenStorageKey(agentId: string) {
  return `coforge:agent-workspace-hidden:${agentId}`;
}

function readHiddenPreference(agentId: string): boolean {
  try {
    return localStorage.getItem(hiddenStorageKey(agentId)) === "1";
  } catch {
    return false;
  }
}

function writeHiddenPreference(agentId: string, value: boolean) {
  try {
    localStorage.setItem(hiddenStorageKey(agentId), value ? "1" : "0");
  } catch {
    // Private mode or blocked storage: the choice still holds for this visit.
  }
}

function sortedEntries(entries: AgentWorkspaceFileEntry[]): AgentWorkspaceFileEntry[] {
  // The daemon already returns directories-first, name-sorted, but this component sorts
  // defensively rather than trusting that contract.
  return [...entries].sort((a, b) => {
    if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function joinPath(dirPath: string, name: string): string {
  return dirPath === "" ? name : `${dirPath}/${name}`;
}

/**
 * The Agent profile panel's Workspace tab: a lazy directory tree of the Agent's working directory
 * on its Computer, plus a read-only file viewer. Owner-only (gated by the caller via
 * `resolveAgentProfileTab`/`showWorkspaceTab`), matching the same publish/poll/timeout data shape
 * as Skills, but with two operations (list, read) instead of one.
 */
export function AgentWorkspaceTab({
  agentId,
  onListDir,
  onReadFile,
}: {
  agentId: string;
  onListDir: (dirPath: string, includeHidden: boolean) => Promise<AgentWorkspaceFilesLoadResult>;
  onReadFile: (path: string) => Promise<AgentWorkspaceFileLoadResult>;
}) {
  const [includeHidden, setIncludeHidden] = useState(() => readHiddenPreference(agentId));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [fileState, setFileState] = useState<FileState | undefined>(undefined);
  const [rootPath, setRootPath] = useState<string | undefined>(undefined);
  const [containerWidth, setContainerWidth] = useState(0);

  const cacheRef = useRef<Record<string, DirState>>({});
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const dirSeq = useRef<Record<string, number>>({});
  const fileSeq = useRef(0);

  const containerRef = useRef<HTMLDivElement | null>(null);
  useResizeObserver({
    ref: containerRef,
    onResize: () => setContainerWidth(containerRef.current?.clientWidth ?? 0),
  });
  useEffect(() => {
    setContainerWidth(containerRef.current?.clientWidth ?? 0);
  }, []);

  const setDirState = useCallback((dirPath: string, state: DirState) => {
    cacheRef.current = { ...cacheRef.current, [dirPath]: state };
    forceRender();
  }, []);

  const loadDir = useCallback(
    async (dirPath: string, hidden: boolean) => {
      const seq = (dirSeq.current[dirPath] ?? 0) + 1;
      dirSeq.current[dirPath] = seq;
      setDirState(dirPath, { status: "loading" });
      try {
        const response = await onListDir(dirPath, hidden);
        if (dirSeq.current[dirPath] !== seq) return;
        if (response.status !== "ready") {
          setDirState(dirPath, { status: response.status });
          return;
        }
        if (response.result.status !== "ok") {
          setDirState(dirPath, { status: response.result.status });
          return;
        }
        if (dirPath === "") setRootPath(response.result.rootPath);
        setDirState(dirPath, { status: "ready", entries: sortedEntries(response.result.entries) });
      } catch {
        if (dirSeq.current[dirPath] === seq) setDirState(dirPath, { status: "error" });
      }
    },
    [onListDir, setDirState],
  );

  const loadFile = useCallback(
    async (path: string) => {
      const seq = ++fileSeq.current;
      setFileState({ status: "loading", path });
      try {
        const response = await onReadFile(path);
        if (fileSeq.current !== seq) return;
        if (response.status !== "ready") {
          setFileState({ status: response.status, path });
          return;
        }
        if (response.result.status === "ok") {
          setFileState({ status: "ready", path, result: response.result });
        } else {
          setFileState({ status: response.result.status, path });
        }
      } catch {
        if (fileSeq.current === seq) setFileState({ status: "error", path });
      }
    },
    [onReadFile],
  );

  useEffect(() => {
    void loadDir("", includeHidden);
    // Reload every directory expanded so far so a hidden-files toggle applies everywhere at once.
    for (const dir of expanded) void loadDir(dir, includeHidden);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch driven by includeHidden/agentId only.
  }, [agentId, includeHidden]);

  function toggleHidden() {
    const next = !includeHidden;
    setIncludeHidden(next);
    writeHiddenPreference(agentId, next);
  }

  function refresh() {
    void loadDir("", includeHidden);
    for (const dir of expanded) void loadDir(dir, includeHidden);
    if (selected) void loadFile(selected);
  }

  // Single entry point for every expansion change, whether it comes from the tree's own
  // chevron toggle (a full next set) or a row click on a directory (one path flipped below).
  // Any directory newly present in `next` that isn't cached yet gets fetched.
  function applyExpanded(next: Set<string>) {
    for (const dirPath of next) {
      if (!expanded.has(dirPath) && !cacheRef.current[dirPath])
        void loadDir(dirPath, includeHidden);
    }
    setExpanded(next);
  }

  function selectFile(path: string) {
    setSelected(path);
    void loadFile(path);
  }

  async function copyPath() {
    if (rootPath) await copyText(rootPath);
  }

  const rootState = cacheRef.current[""];
  const showSplit = containerWidth >= SPLIT_BREAKPOINT_PX;
  const narrowShowingFile = !showSplit && selected !== undefined;

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-secondary px-5 py-3">
        <span className="min-w-0 truncate font-mono text-xs text-tertiary">{rootPath ?? " "}</span>
        {rootPath && (
          <ButtonUtility
            icon={Copy01}
            size="xs"
            color="tertiary"
            tooltip={m.agent_workspace_copy_path()}
            onClick={() => void copyPath()}
          />
        )}
      </div>

      {!showSplit && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-secondary px-5 py-2.5">
          <p className={SECTION_CAPTION_CLASS}>{m.agent_workspace_section()}</p>
          <HiddenAndRefreshButtons
            includeHidden={includeHidden}
            onToggleHidden={toggleHidden}
            onRefresh={refresh}
          />
        </div>
      )}

      {narrowShowingFile ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-secondary px-3 py-2">
            <ButtonUtility
              icon={ArrowLeft}
              size="xs"
              color="tertiary"
              tooltip={m.agent_workspace_back()}
              onClick={() => setSelected(undefined)}
            />
            <span className="min-w-0 truncate font-mono text-xs text-tertiary">{selected}</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <FilePane state={fileState} onRetry={() => selected && loadFile(selected)} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            className={cn(
              "flex min-h-0 flex-col",
              showSplit ? "w-72 shrink-0 border-r border-secondary" : "min-h-0 flex-1",
            )}
          >
            {showSplit && (
              <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-2">
                <p className={SECTION_CAPTION_CLASS}>{m.agent_workspace_section()}</p>
                <HiddenAndRefreshButtons
                  includeHidden={includeHidden}
                  onToggleHidden={toggleHidden}
                  onRefresh={refresh}
                />
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <TreeRoot
                state={rootState}
                cache={cacheRef.current}
                expanded={expanded}
                selected={selected}
                onExpandedChange={applyExpanded}
                onSelectFile={selectFile}
                onRetry={() => loadDir("", includeHidden)}
              />
            </div>
          </div>
          {showSplit && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {selected ? (
                <FilePane state={fileState} onRetry={() => selected && loadFile(selected)} />
              ) : (
                <p className="px-5 py-16 text-center text-sm text-tertiary">
                  {m.agent_workspace_select_file()}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HiddenAndRefreshButtons({
  includeHidden,
  onToggleHidden,
  onRefresh,
}: {
  includeHidden: boolean;
  onToggleHidden: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <ButtonUtility
        icon={includeHidden ? Eye : EyeOff}
        size="xs"
        color="tertiary"
        tooltip={
          includeHidden
            ? m.agent_workspace_hidden_files_shown()
            : m.agent_workspace_hidden_files_hidden()
        }
        onClick={onToggleHidden}
      />
      <ButtonUtility
        icon={RefreshCw01}
        size="xs"
        color="tertiary"
        tooltip={m.agent_workspace_refresh()}
        onClick={onRefresh}
      />
    </div>
  );
}

function TreeRoot({
  state,
  cache,
  expanded,
  selected,
  onExpandedChange,
  onSelectFile,
  onRetry,
}: {
  state: DirState | undefined;
  cache: Record<string, DirState>;
  expanded: Set<string>;
  selected: string | undefined;
  onExpandedChange: (next: Set<string>) => void;
  onSelectFile: (path: string) => void;
  onRetry: () => void;
}) {
  if (!state || state.status === "loading") {
    return (
      <div className="space-y-2 px-3 py-3" aria-busy="true">
        {[0, 1, 2, 3, 4].map((index) => (
          <div
            key={index}
            className="h-3 animate-pulse rounded bg-secondary motion-reduce:animate-none"
            style={{ width: `${70 - index * 8}%` }}
          />
        ))}
      </div>
    );
  }
  if (state.status === "offline") return <TreeMessage text={m.agent_workspace_offline()} />;
  if (state.status === "timeout")
    return <TreeMessage text={m.agent_workspace_timeout()} onRetry={onRetry} />;
  if (state.status !== "ready")
    return <TreeMessage text={m.agent_workspace_unavailable()} onRetry={onRetry} />;
  if (state.entries.length === 0) return <TreeMessage text={m.agent_workspace_empty()} />;

  return (
    <WorkspaceTree
      rootEntries={state.entries}
      cache={cache}
      expanded={expanded}
      selected={selected}
      onExpandedChange={onExpandedChange}
      onSelectFile={onSelectFile}
    />
  );
}

/** One row of the tree: either a real file/directory entry, or a non-interactive placeholder
 * standing in for a directory's loading/empty/error child state. */
type TreeRow =
  | { kind: "entry"; entry: AgentWorkspaceFileEntry; path: string }
  | { kind: "status"; id: string; loading: boolean; text: string };

function childRows(dirPath: string, cache: Record<string, DirState>): TreeRow[] {
  const state = cache[dirPath];
  if (!state || state.status === "loading") {
    return [{ kind: "status", id: `${dirPath}::loading`, loading: true, text: "" }];
  }
  if (state.status === "ready") {
    if (state.entries.length === 0) {
      return [
        {
          kind: "status",
          id: `${dirPath}::empty`,
          loading: false,
          text: m.agent_workspace_directory_empty(),
        },
      ];
    }
    return state.entries.map((entry) => ({
      kind: "entry",
      entry,
      path: joinPath(dirPath, entry.name),
    }));
  }
  return [
    {
      kind: "status",
      id: `${dirPath}::error`,
      loading: false,
      text: m.agent_workspace_directory_error(),
    },
  ];
}

/**
 * The lazily-loaded directory tree, built on React Aria's `Tree`. Collapsed directories
 * contribute no rows to the Collection, so expanding one is the only point a fetch happens.
 */
function WorkspaceTree({
  rootEntries,
  cache,
  expanded,
  selected,
  onExpandedChange,
  onSelectFile,
}: {
  rootEntries: AgentWorkspaceFileEntry[];
  cache: Record<string, DirState>;
  expanded: Set<string>;
  selected: string | undefined;
  onExpandedChange: (next: Set<string>) => void;
  onSelectFile: (path: string) => void;
}) {
  function toggleExpandPath(path: string) {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    onExpandedChange(next);
  }

  function renderRow(row: TreeRow) {
    if (row.kind === "status") {
      return (
        <TreeItem id={row.id} textValue={row.text || m.agent_workspace_loading()} isDisabled>
          <TreeItemContent>
            {({ level }) => (
              <div
                className="flex min-w-0 items-center gap-1.5 py-1.5 pr-2 text-xs text-tertiary"
                style={{ paddingLeft: 4 + (level - 1) * 16 }}
              >
                <span aria-hidden="true" className="size-6 shrink-0" />
                {row.loading ? (
                  <span className="block h-3 w-2/3 animate-pulse rounded bg-secondary motion-reduce:animate-none" />
                ) : (
                  row.text
                )}
              </div>
            )}
          </TreeItemContent>
        </TreeItem>
      );
    }

    const { entry, path } = row;
    const isDir = entry.type === "dir";
    const isCurrent = !isDir && selected === path;

    return (
      <TreeItem
        id={path}
        textValue={entry.name}
        hasChildItems={isDir}
        onAction={() => (isDir ? toggleExpandPath(path) : onSelectFile(path))}
        className={cn(
          "cursor-pointer rounded-md outline-none data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-focus-ring data-hovered:bg-primary_hover",
          isCurrent && "bg-secondary",
        )}
      >
        <TreeItemContent>
          {({ level, isExpanded }) => (
            <div
              className="flex min-w-0 items-center gap-1.5 pr-2"
              style={{ paddingLeft: 4 + (level - 1) * 16 }}
            >
              {isDir ? (
                <AriaButton
                  slot="chevron"
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-quaternary outline-focus-ring hover:text-tertiary focus-visible:outline-2"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      "size-3.5 transition-transform motion-reduce:transition-none",
                      isExpanded && "rotate-90",
                    )}
                  />
                </AriaButton>
              ) : (
                <span aria-hidden="true" className="size-6 shrink-0" />
              )}
              {isDir ? (
                <Folder aria-hidden="true" className="size-4 shrink-0 text-quaternary" />
              ) : (
                <File02 aria-hidden="true" className="size-4 shrink-0 text-quaternary" />
              )}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate py-1.5 text-sm text-primary",
                  isCurrent && "font-medium",
                )}
              >
                {entry.name}
              </span>
            </div>
          )}
        </TreeItemContent>
        {/* Collapsed directories contribute no rows; files pass an always-empty list. */}
        <Collection
          items={isDir && expanded.has(path) ? childRows(path, cache) : []}
          dependencies={[expanded, cache, selected]}
        >
          {renderRow}
        </Collection>
      </TreeItem>
    );
  }

  return (
    <Tree
      aria-label={m.agent_workspace_section()}
      items={rootEntries.map((entry): TreeRow => ({ kind: "entry", entry, path: entry.name }))}
      dependencies={[expanded, cache, selected]}
      expandedKeys={expanded}
      onExpandedChange={(keys) => onExpandedChange(new Set([...keys].map(String)))}
      className="space-y-0.5 px-2 pb-3 outline-none"
    >
      {renderRow}
    </Tree>
  );
}

function TreeMessage({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <p className="text-sm text-tertiary">{text}</p>
      {onRetry && (
        <Button size="sm" color="secondary" onPress={onRetry}>
          {m.agent_workspace_retry()}
        </Button>
      )}
    </div>
  );
}

function FilePane({ state, onRetry }: { state: FileState | undefined; onRetry: () => void }) {
  if (!state || state.status === "loading") {
    const name = state?.path.split("/").pop() ?? "";
    return <ProjectFileViewSkeleton name={name} />;
  }
  const name = state.path.split("/").pop() ?? state.path;

  if (state.status === "ready")
    return (
      <ProjectFileView
        key={state.path}
        path={state.path}
        name={name}
        byteSize={state.result.sizeBytes}
        text={state.result.text}
        githubUrl={undefined}
      />
    );
  if (state.status === "offline") return <EmptyFileState text={m.agent_workspace_offline()} />;
  if (state.status === "timeout")
    return <EmptyFileState text={m.agent_workspace_timeout()} onRetry={onRetry} />;
  if (state.status === "binary") return <EmptyFileState text={m.agent_workspace_binary()} />;
  if (state.status === "too_large") return <EmptyFileState text={m.agent_workspace_too_large()} />;
  return <EmptyFileState text={m.agent_workspace_file_error()} onRetry={onRetry} />;
}

function EmptyFileState({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-16 text-center">
      <p className="text-sm text-tertiary">{text}</p>
      {onRetry && (
        <Button size="sm" color="secondary" onPress={onRetry}>
          {m.agent_workspace_retry()}
        </Button>
      )}
    </div>
  );
}
