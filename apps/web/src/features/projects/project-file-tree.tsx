import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
  ChevronRight,
  Copy01,
  Download01,
  File02,
  Folder,
  LinkExternal01,
} from "@untitledui/icons";
import {
  Button as AriaButton,
  Collection,
  Link as AriaLink,
  NavigationTree,
  NavigationTreeItem,
  NavigationTreeItemContent,
  RouterProvider,
  type Key,
} from "react-aria-components";
import { Dropdown } from "@/components/base/dropdown/dropdown";
import { copyText } from "@/features/records/report-editor/lib/clipboard";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { projectObjectQuery } from "./project-tree-queries";
import { ancestorPaths, childrenOf, type TreeEntry, type TreeIndex } from "./tree-index";

/**
 * The repository's side tree. Folders expand from the already-loaded index, so the only
 * request a row ever causes is the hover prefetch of a file's content.
 */
export function ProjectFileTree({
  slug,
  projectId,
  index,
  currentPath,
  className,
}: {
  slug: string;
  projectId: string;
  index: TreeIndex;
  currentPath: string;
  className?: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const hrefOf = (path: string) =>
    router.buildLocation({
      to: "/projects/$projectSlug/tree/$",
      params: { projectSlug: slug, _splat: path },
    }).href;

  // The folders holding the current file open by themselves; everything else is the User's.
  const [expandedKeys, setExpandedKeys] = useState<Set<Key>>(
    () => new Set(ancestorPaths(currentPath).concat(currentPath)),
  );
  const [revealedPath, setRevealedPath] = useState(currentPath);
  if (revealedPath !== currentPath) {
    setRevealedPath(currentPath);
    setExpandedKeys((keys) => new Set([...keys, ...ancestorPaths(currentPath), currentPath]));
  }

  function renderEntry(entry: TreeEntry) {
    const isDirectory = entry.type === "dir";
    const isBrowsable = isDirectory || entry.type === "file";
    const href = hrefOf(entry.path);
    return (
      <NavigationTreeItem
        id={entry.path}
        textValue={entry.name}
        href={isBrowsable ? href : undefined}
        hasChildItems={isDirectory}
        onHoverStart={() => {
          if (entry.type === "file")
            void queryClient.query(projectObjectQuery(slug, entry.path, entry.sha)).catch(() => {});
        }}
        className="group/row block rounded-md outline-none data-current:bg-sidebar-accent data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-focus-ring data-hovered:bg-primary_hover"
      >
        <NavigationTreeItemContent>
          {({ level, isExpanded, isCurrent }) => (
            <div
              className="flex min-w-0 items-center gap-1 pr-1"
              style={{ paddingLeft: 4 + (level - 1) * 16 }}
            >
              {isDirectory ? (
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
              <AriaLink
                className={cn(
                  "flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1.5 text-sm outline-none",
                  isCurrent ? "font-semibold text-brand-secondary" : "text-secondary",
                )}
              >
                {isDirectory ? (
                  <Folder aria-hidden="true" className="size-4 shrink-0 text-quaternary" />
                ) : (
                  <File02 aria-hidden="true" className="size-4 shrink-0 text-quaternary" />
                )}
                <span className="truncate">{entry.name}</span>
              </AriaLink>
              <Dropdown.Root>
                <Dropdown.DotsButton
                  aria-label={m.project_file_actions({ name: entry.name })}
                  className="flex size-6 shrink-0 items-center justify-center opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 aria-expanded:opacity-100 [&_svg]:size-4"
                />
                <Dropdown.Popover className="w-48" placement="left top">
                  <Dropdown.Menu>
                    {isBrowsable && (
                      <Dropdown.Item
                        icon={LinkExternal01}
                        label={m.project_file_open_new_tab()}
                        href={href}
                        target="_blank"
                      />
                    )}
                    {isBrowsable && <Dropdown.Separator />}
                    {entry.type === "file" && (
                      <Dropdown.Item
                        icon={Download01}
                        label={m.project_file_download()}
                        href={downloadUrl(projectId, entry.path)}
                        download={entry.name}
                      />
                    )}
                    <Dropdown.Item
                      icon={Copy01}
                      label={m.project_file_copy_path()}
                      onAction={() => void copyText(entry.path)}
                    />
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown.Root>
            </div>
          )}
        </NavigationTreeItemContent>
        {/* Collapsed folders contribute no rows, so a 100k-entry tree stays a few hundred nodes. */}
        <Collection
          items={expandedKeys.has(entry.path) ? childrenOf(index, entry.path) : []}
          dependencies={[expandedKeys, currentPath]}
        >
          {renderEntry}
        </Collection>
      </NavigationTreeItem>
    );
  }

  return (
    // Scoped to the tree: its rows are React Aria links, which would otherwise reload the page.
    <RouterProvider navigate={(href) => router.history.push(href)}>
      <NavigationTree
        aria-label={m.project_tree_files()}
        items={childrenOf(index, "")}
        dependencies={[expandedKeys, currentPath]}
        expandedKeys={expandedKeys}
        onExpandedChange={setExpandedKeys}
        selectedRoute={currentPath === "" ? null : hrefOf(currentPath)}
        className={cn("space-y-0.5 overflow-y-auto outline-none", className)}
      >
        {renderEntry}
      </NavigationTree>
    </RouterProvider>
  );
}

export function downloadUrl(projectId: string, path: string) {
  return `/api/projects/${projectId}/raw/${path.split("/").map(encodeURIComponent).join("/")}`;
}
