import { Fragment, useMemo, useState } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, notFound } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  File02,
  Folder,
  LayoutLeft,
  LayoutRight,
} from "@untitledui/icons";
import { Button as AriaButton, Disclosure, DisclosurePanel, Heading } from "react-aria-components";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { Button } from "@/components/base/buttons/button";
import { PageHeader } from "@/components/layout/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { conversationLayoutStorage } from "@/features/conversations/layout-storage";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { downloadUrl, ProjectFileTree } from "./project-file-tree";
import { ProjectFileView, ProjectFileViewSkeleton } from "./project-file-view";
import {
  projectDirectoryCommitsQuery,
  projectObjectQuery,
  projectQuery,
  projectTreeQuery,
} from "./project-tree-queries";
import { RepositoryStatusMessage } from "./repository-status";
import { buildTreeIndex, childrenOf, type TreeEntry } from "./tree-index";

type LastCommit = { sha: string; message: string; date: string } | null;
type TreeSide = "left" | "right";

const TREE_SIDE_KEY = "coforge-project-tree-side";
const crumbLinkClassName =
  "max-w-32 shrink-0 truncate rounded p-1 outline-focus-ring hover:text-primary hover:underline focus-visible:outline-2";

/** Per-device preference, like the rail labels: which side the file tree sits on. */
function readTreeSide(): TreeSide {
  try {
    return localStorage.getItem(TREE_SIDE_KEY) === "left" ? "left" : "right";
  } catch {
    return "right";
  }
}

/**
 * The repository browser. The header, breadcrumb and side tree stay mounted while the User
 * moves between files; only the content pane waits on a request, behind its own skeleton.
 */
export function ProjectTree({ slug, path }: { slug: string; path: string }) {
  const queryClient = useQueryClient();
  const { data: project } = useSuspenseQuery(projectQuery(slug));
  const { data: repository } = useSuspenseQuery(projectTreeQuery(slug));
  const [treeSide, setTreeSide] = useState(readTreeSide);
  // One tree instance at a time: a second, hidden copy would double the rows and the prefetches.
  const isDesktop = useBreakpoint("lg");
  const layout = useDefaultLayout({
    id: "coforge-project-tree",
    panelIds: isDesktop ? ["main", "tree"] : ["main"],
    onlySaveAfterUserInteractions: true,
    storage: conversationLayoutStorage,
  });
  const index = useMemo(
    () => buildTreeIndex(repository.status === "ready" ? repository.entries : []),
    [repository],
  );
  // The route loader already turned a missing Project into notFound().
  if (!project) throw notFound();
  const segments = path === "" ? [] : path.split("/");

  if (repository.status !== "ready") {
    if (repository.status === "not_found") throw notFound();
    return (
      <main className="flex h-svh min-w-0 flex-col bg-primary">
        <PageHeader
          heading={project.name}
          leading={
            <div className="flex min-w-0 items-center gap-1">
              <BackLink />
            </div>
          }
        />
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <RepositoryStatusMessage
            status={repository.status}
            onRetry={() => queryClient.invalidateQueries({ queryKey: ["project", slug] })}
          />
        </div>
      </main>
    );
  }

  const { fullName, defaultBranch } = repository;
  const entry = path === "" ? undefined : index.byPath.get(path);
  const isFile = entry ? entry.type !== "dir" : false;
  const githubUrl = buildGithubUrl(fullName, defaultBranch, path, isFile ? "blob" : "tree");

  function toggleTreeSide() {
    const next = treeSide === "right" ? "left" : "right";
    setTreeSide(next);
    try {
      localStorage.setItem(TREE_SIDE_KEY, next);
    } catch {
      // Private mode or blocked storage: the choice still holds for this visit.
    }
  }

  const tree = (className?: string) => (
    <ProjectFileTree
      slug={slug}
      projectId={project.id}
      index={index}
      currentPath={path}
      className={className}
    />
  );
  const truncatedNotice = repository.truncated && (
    <p className="px-3 py-2 text-xs text-tertiary">{m.project_tree_truncated()}</p>
  );

  const mainPanel = (
    <Panel
      key="main"
      id="main"
      // Strings are percentages of the group; numbers would be pixels.
      minSize="50"
      className="flex min-h-0 min-w-0 flex-col"
    >
      {!isDesktop && (
        <Disclosure className="border-b border-secondary">
          {({ isExpanded }) => (
            <>
              <Heading>
                <AriaButton
                  slot="trigger"
                  className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium text-primary outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0 transition-transform",
                      isExpanded && "rotate-90",
                    )}
                  />
                  {m.project_tree_files()}
                </AriaButton>
              </Heading>
              <DisclosurePanel className="border-t border-secondary px-3 py-2">
                {tree("max-h-[50vh]")}
                {truncatedNotice}
              </DisclosurePanel>
            </>
          )}
        </Disclosure>
      )}
      {!entry && path !== "" ? (
        // Only reachable when GitHub truncated the tree: the path is not in the index.
        <UnindexedPath
          slug={slug}
          projectId={project.id}
          path={path}
          fullName={fullName}
          defaultBranch={defaultBranch}
          treeSha={repository.sha}
        />
      ) : !entry || entry.type === "dir" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <DirectoryBody
            slug={slug}
            path={path}
            entries={childrenOf(index, path)}
            fullName={fullName}
            defaultBranch={defaultBranch}
            treeSha={repository.sha}
          />
        </div>
      ) : entry.type === "file" ? (
        <FileBody
          slug={slug}
          projectId={project.id}
          path={path}
          oid={entry.sha}
          githubUrl={githubUrl}
        />
      ) : (
        <ProjectFileView
          path={path}
          name={entry.name}
          byteSize={0}
          text={null}
          githubUrl={githubUrl}
          downloadUrl={downloadUrl(project.id, path)}
        />
      )}
    </Panel>
  );
  const treePanel = (
    <Panel
      key="tree"
      id="tree"
      defaultSize="22"
      minSize="14"
      maxSize="45"
      className="flex min-h-0 min-w-0 flex-col"
    >
      <div className="flex items-center justify-between pt-3 pr-2 pb-1 pl-5">
        <h2 className="text-xs font-semibold tracking-wide text-quaternary uppercase">
          {m.project_tree_files()}
        </h2>
        <Button
          size="sm"
          color="tertiary"
          iconLeading={treeSide === "right" ? LayoutLeft : LayoutRight}
          aria-label={
            treeSide === "right" ? m.project_tree_move_left() : m.project_tree_move_right()
          }
          onPress={toggleTreeSide}
        />
      </div>
      {tree("min-h-0 flex-1 px-2 pb-3")}
      {truncatedNotice}
    </Panel>
  );
  const separator = (
    <Separator
      key="separator"
      aria-label={m.project_tree_files()}
      className="w-px shrink-0 bg-border-secondary transition-colors hover:bg-brand-solid data-[separator=active]:bg-brand-solid"
    />
  );

  return (
    <main className="flex h-svh min-w-0 flex-col bg-primary">
      <PageHeader
        heading={segments.at(-1) ?? defaultBranch}
        leading={
          <div className="flex min-w-0 items-center gap-1">
            <BackLink />
            <Breadcrumb
              projectSlug={project.slug}
              projectName={project.name}
              branch={defaultBranch}
              segments={segments}
            />
          </div>
        }
        actions={
          <a
            href={githubUrl}
            target="_blank"
            rel="noreferrer"
            className="flex shrink-0 items-center gap-1 text-sm text-tertiary hover:text-primary"
          >
            GitHub
            <ArrowUpRight aria-hidden="true" className="size-4" />
          </a>
        }
      />
      <Group
        // The saved widths belong to a panel order, so each side keeps its own.
        key={isDesktop ? treeSide : "stacked"}
        id={`project-tree-${treeSide}`}
        orientation="horizontal"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        className="flex min-h-0 min-w-0 flex-1"
      >
        {treeSide === "left"
          ? [treePanel, separator, mainPanel]
          : [mainPanel, separator, treePanel]}
      </Group>
    </main>
  );
}

/** A file's content is the one thing a click waits for; everything around it is already there. */
function FileBody({
  slug,
  projectId,
  path,
  oid,
  githubUrl,
}: {
  slug: string;
  projectId: string;
  path: string;
  oid?: string;
  githubUrl: string;
}) {
  const queryClient = useQueryClient();
  const name = path.split("/").pop() ?? path;
  const { data } = useQuery(projectObjectQuery(slug, path, oid));
  if (!data) return <ProjectFileViewSkeleton name={name} />;
  if (data.status === "not_found") throw notFound();
  if (data.status !== "ready" || data.node.kind !== "blob")
    return (
      <RepositoryStatusMessage
        status={data.status === "ready" ? "unavailable" : data.status}
        onRetry={() => queryClient.invalidateQueries({ queryKey: ["project", slug, "object"] })}
      />
    );
  return (
    <ProjectFileView
      // Tab and copy state belong to one file.
      key={path}
      path={path}
      name={name}
      byteSize={data.node.byteSize}
      text={data.node.text}
      githubUrl={githubUrl}
      downloadUrl={downloadUrl(projectId, path)}
    />
  );
}

function UnindexedPath({
  slug,
  projectId,
  path,
  fullName,
  defaultBranch,
  treeSha,
}: {
  slug: string;
  projectId: string;
  path: string;
  fullName: string;
  defaultBranch: string;
  treeSha: string;
}) {
  const { data } = useQuery(projectObjectQuery(slug, path));
  if (data?.status === "ready" && data.node.kind === "tree")
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <DirectoryBody
          slug={slug}
          path={path}
          entries={data.node.entries}
          fullName={fullName}
          defaultBranch={defaultBranch}
          treeSha={treeSha}
        />
      </div>
    );
  return (
    <FileBody
      slug={slug}
      projectId={projectId}
      path={path}
      githubUrl={buildGithubUrl(fullName, defaultBranch, path, "blob")}
    />
  );
}

function BackLink() {
  return (
    <Link
      to="/projects"
      aria-label={m.project_back()}
      className="shrink-0 rounded-lg p-2 text-tertiary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
    >
      <ArrowLeft aria-hidden="true" className="size-5" />
    </Link>
  );
}

function Breadcrumb({
  projectSlug,
  projectName,
  branch,
  segments,
}: {
  projectSlug: string;
  projectName: string;
  branch: string;
  segments: string[];
}) {
  const trail = [
    { label: projectName, to: "project" as const },
    { label: branch, to: "tree" as const, splat: "" },
    ...segments.map((label, index) => ({
      label,
      to: "tree" as const,
      splat: segments.slice(0, index + 1).join("/"),
    })),
  ];
  // The last crumb becomes the page's bold PageHeader heading; only the rest render here.
  const links = trail.slice(0, -1);
  // Mobile keeps the last segment before the heading (so heading + this = "last two
  // segments" overall) and collapses everything earlier to an ellipsis.
  const mobileLinks = links.length > 1 ? links.slice(-1) : links;

  function renderCrumb(crumb: (typeof links)[number], index: number) {
    return (
      <Fragment key={index}>
        <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-quaternary" />
        {crumb.to === "project" ? (
          <Link to="/projects/$projectSlug" params={{ projectSlug }} className={crumbLinkClassName}>
            {crumb.label}
          </Link>
        ) : (
          <Link
            to="/projects/$projectSlug/tree/$"
            params={{ projectSlug, _splat: crumb.splat }}
            className={crumbLinkClassName}
          >
            {crumb.label}
          </Link>
        )}
      </Fragment>
    );
  }

  return (
    <>
      <nav
        aria-label={m.project_tree_files()}
        className="flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap text-sm text-tertiary sm:hidden"
      >
        {mobileLinks.length < links.length && (
          <span aria-hidden="true" className="shrink-0 text-quaternary">
            …
          </span>
        )}
        {mobileLinks.map(renderCrumb)}
      </nav>
      <nav
        aria-label={m.project_tree_files()}
        className="hidden min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap text-sm text-tertiary sm:flex"
      >
        <Link to="/projects" className={crumbLinkClassName}>
          {m.projects_title()}
        </Link>
        {links.map(renderCrumb)}
      </nav>
    </>
  );
}

function DirectoryBody({
  slug,
  path,
  entries,
  fullName,
  defaultBranch,
  treeSha,
}: {
  slug: string;
  path: string;
  entries: ReadonlyArray<Pick<TreeEntry, "name" | "path" | "type">>;
  fullName: string;
  defaultBranch: string;
  treeSha: string;
}) {
  const projectSlug = slug;
  // The listing renders from the tree at once; last commits fill in when their request lands.
  const { data: history } = useQuery(projectDirectoryCommitsQuery(slug, path, treeSha));
  const commits: Record<string, LastCommit> = history?.status === "ready" ? history.commits : {};
  const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const rowClassName =
    "flex min-w-0 items-center gap-3 px-4 py-2.5 outline-focus-ring hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2";
  return (
    <div className="overflow-hidden rounded-xl border border-secondary">
      <ul className="divide-y divide-secondary">
        {path !== "" && (
          <li>
            <Link
              to="/projects/$projectSlug/tree/$"
              params={{ projectSlug, _splat: parentPath }}
              className={cn(rowClassName, "text-tertiary")}
            >
              <Folder aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
              <span className="text-sm">{m.project_tree_parent()}</span>
            </Link>
          </li>
        )}
        {entries.length === 0 ? (
          <li className="px-4 py-16 text-center text-sm text-tertiary">{m.project_tree_empty()}</li>
        ) : (
          entries.map((entry) => {
            const content = (
              <>
                {entry.type === "dir" ? (
                  <Folder aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
                ) : (
                  <File02 aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
                )}
                <span
                  className={cn(
                    "w-56 shrink-0 truncate text-sm text-primary",
                    entry.type === "dir" && "font-medium",
                  )}
                >
                  {entry.name}
                </span>
                <span className="hidden min-w-0 flex-1 truncate text-xs text-tertiary sm:block">
                  {commits[entry.path]?.message.split("\n")[0]}
                </span>
                {commits[entry.path]?.date && (
                  <RelativeTime
                    value={commits[entry.path]!.date}
                    plain
                    className="shrink-0 text-xs text-tertiary"
                  />
                )}
              </>
            );
            return (
              <li key={entry.path}>
                {entry.type === "dir" || entry.type === "file" ? (
                  <Link
                    to="/projects/$projectSlug/tree/$"
                    params={{ projectSlug, _splat: entry.path }}
                    className={rowClassName}
                  >
                    {content}
                  </Link>
                ) : (
                  <a
                    // Reached only for "symlink"/"submodule" — neither is "dir", so this is always a blob URL.
                    href={buildGithubUrl(fullName, defaultBranch, entry.path, "blob")}
                    target="_blank"
                    rel="noreferrer"
                    className={rowClassName}
                  >
                    {content}
                    <ArrowUpRight
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-quaternary"
                    />
                  </a>
                )}
              </li>
            );
          })
        )}
      </ul>
    </div>
  );
}

function buildGithubUrl(
  fullName: string,
  branch: string,
  path: string,
  kind: "tree" | "blob",
): string {
  const base = `https://github.com/${fullName}`;
  if (path === "") return base;
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${base}/${kind}/${encodeURIComponent(branch)}/${encodedPath}`;
}
