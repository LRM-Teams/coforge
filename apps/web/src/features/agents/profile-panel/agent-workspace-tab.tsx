import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ArrowLeft, Copy01, Eye, EyeOff, RefreshCw01 } from "@untitledui/icons";
import { Collection, Tree, TreeItem, TreeItemContent } from "react-aria-components";
import type {
  AgentWorkspaceFileEntry,
  AgentWorkspaceFileReadResult,
  AgentWorkspaceFilesListResult,
} from "@lrm/coforge-sdk/internal";

import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { ContentEditor } from "@/features/records/report-editor/content-editor";
import { copyText } from "@/features/records/report-editor/lib/clipboard";
import { formatFileSize, getFileExtension } from "@/features/records/report-editor/utils/file-meta";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { cn } from "@/lib/utils";
import {
  FILE_TREE_CURRENT_ITEM_CLASS,
  FILE_TREE_ITEM_CLASS,
  FileTreeRow,
  fileTreeIndent,
} from "@/components/ui/file-tree";
import { SECTION_CAPTION_CLASS } from "./inline-edit-field";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

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

  const cacheRef = useRef<Record<string, DirState>>({});
  const [, forceRender] = useReducer((n: number) => n + 1, 0);
  const dirSeq = useRef<Record<string, number>>({});
  const fileSeq = useRef(0);

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

  // One column at every width: the tree, or the open file in its place with a way back.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-secondary px-5 py-3">
        <span className="min-w-0 truncate font-mono text-xs text-tertiary">{rootPath ?? " "}</span>
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

      {selected !== undefined ? (
        <FilePane
          key={selected}
          path={selected}
          state={fileState}
          onBack={() => setSelected(undefined)}
          onRetry={() => loadFile(selected)}
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 border-b border-secondary px-5 py-2.5">
            <p className={SECTION_CAPTION_CLASS}>{m.agent_workspace_section()}</p>
            <HiddenAndRefreshButtons
              includeHidden={includeHidden}
              onToggleHidden={toggleHidden}
              onRefresh={refresh}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pt-2">
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
        </>
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
                className="flex min-w-0 items-center gap-1 py-1.5 pr-1 text-xs text-tertiary"
                style={{ paddingLeft: fileTreeIndent(level) }}
              >
                {/* Under the chevron column, so the text lines up with the folder's entries. */}
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
        className={cn(FILE_TREE_ITEM_CLASS, isCurrent && FILE_TREE_CURRENT_ITEM_CLASS)}
      >
        <TreeItemContent>
          {({ level, isExpanded }) => (
            <FileTreeRow
              level={level}
              name={entry.name}
              isDirectory={isDir}
              isExpanded={isExpanded}
              isCurrent={isCurrent}
            />
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

/**
 * The open file in place of the tree: back + name, a Raw/Preview switch for Markdown, the
 * content, and its size and modification time.
 */
function FilePane({
  path,
  state,
  onBack,
  onRetry,
}: {
  path: string;
  state: FileState | undefined;
  onBack: () => void;
  onRetry: () => void;
}) {
  const [mode, setMode] = useState<"preview" | "raw">("preview");
  const name = path.split("/").pop() ?? path;
  const ready = state?.status === "ready" && state.path === path ? state : undefined;
  const text = ready?.result.text;
  const isMarkdown = MARKDOWN_EXTENSIONS.has(getFileExtension(name));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-secondary py-2 pr-5 pl-3">
        <ButtonUtility
          icon={ArrowLeft}
          size="xs"
          color="tertiary"
          tooltip={m.agent_workspace_back()}
          onClick={onBack}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-secondary">{path}</span>
        {isMarkdown && text !== undefined && (
          <ButtonGroup
            aria-label={m.agent_workspace_view_mode()}
            size="sm"
            selectedKeys={[mode]}
            disallowEmptySelection
            onSelectionChange={(keys) => {
              const next = [...keys][0];
              if (next === "preview" || next === "raw") setMode(next);
            }}
          >
            <ButtonGroupItem id="raw">{m.agent_workspace_raw()}</ButtonGroupItem>
            <ButtonGroupItem id="preview">{m.agent_workspace_preview()}</ButtonGroupItem>
          </ButtonGroup>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!state || state.status === "loading" || state.path !== path ? (
          <div className="space-y-2 px-5 py-4" aria-busy="true">
            {[0, 1, 2, 3, 4].map((index) => (
              <div
                key={index}
                className="h-3 animate-pulse rounded bg-secondary motion-reduce:animate-none"
                style={{ width: `${80 - index * 10}%` }}
              />
            ))}
          </div>
        ) : text !== undefined ? (
          isMarkdown && mode === "preview" ? (
            <div className="px-5 py-4">
              <ContentEditor key={path} editable={false} defaultValue={text} />
            </div>
          ) : (
            <pre className="px-5 py-4 font-mono text-xs/5 break-words whitespace-pre-wrap text-primary">
              {text}
            </pre>
          )
        ) : state.status === "offline" ? (
          <EmptyFileState text={m.agent_workspace_offline()} />
        ) : state.status === "timeout" ? (
          <EmptyFileState text={m.agent_workspace_timeout()} onRetry={onRetry} />
        ) : state.status === "binary" ? (
          <EmptyFileState text={m.agent_workspace_binary()} />
        ) : state.status === "too_large" ? (
          <EmptyFileState text={m.agent_workspace_too_large()} />
        ) : (
          <EmptyFileState text={m.agent_workspace_file_error()} onRetry={onRetry} />
        )}
      </div>

      {ready && (
        <div className="border-t border-secondary px-5 py-2 font-mono text-xs text-tertiary tabular-nums">
          {formatFileSize(ready.result.sizeBytes)} ·{" "}
          {new Date(ready.result.modifiedAtMs).toLocaleString(getLocale(), {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </div>
      )}
    </div>
  );
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
