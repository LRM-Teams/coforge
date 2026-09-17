import { Fragment, useMemo } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, notFound } from "@tanstack/react-router";
import { ArrowLeft, ArrowUpRight, ChevronRight, File02, Folder } from "@untitledui/icons";
import { Button as AriaButton, Disclosure, DisclosurePanel, Heading } from "react-aria-components";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { Avatar } from "@/components/base/avatar/avatar";
import { PageHeader } from "@/components/layout/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { conversationLayoutStorage } from "@/features/conversations/layout-storage";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import { ProjectFileTree } from "./project-file-tree";
import { githubUrl as buildGithubUrl, projectFileDownloadUrl } from "./project-file-urls";
import { ProjectFileView, ProjectFileViewSkeleton } from "./project-file-view";
import {
  projectDirectoryCommitsQuery,
  projectObjectQuery,
  projectQuery,
  projectTreeQuery,
} from "./project-tree-queries";
import { RepositoryStatusMessage } from "./repository-status";
import { buildTreeIndex, childrenOf, isBrowsable, type TreeEntry } from "./tree-index";

type LastCommit = { sha: string; message: string; date: string } | null;
const crumbLinkClassName =
  "max-w-32 shrink-0 truncate rounded p-1 outline-focus-ring hover:text-primary hover:underline focus-visible:outline-2";

/**
 * The repository browser. The header, breadcrumb and side tree stay mounted while the User
 * moves between files; only the content pane waits on a request, behind its own skeleton.
 */
export function ProjectTree({ slug, path }: { slug: string; path: string }) {
  const queryClient = useQueryClient();
  const { data: project } = useSuspenseQuery(projectQuery(slug));
  const { data: repository } = useSuspenseQuery(projectTreeQuery(slug));
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
        <ProjectFileView path={path} name={entry.name} text={null} githubUrl={githubUrl} />
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
      <h2 className="px-5 pt-4 pb-2 text-xs font-semibold tracking-wide text-quaternary uppercase">
        {m.project_tree_files()}
      </h2>
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
        key={isDesktop ? "split" : "stacked"}
        id="project-tree"
        orientation="horizontal"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        className="flex min-h-0 min-w-0 flex-1"
      >
        {isDesktop ? [mainPanel, separator, treePanel] : mainPanel}
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
  const { data, isError } = useQuery(projectObjectQuery(slug, path, oid));
  const retry = () => queryClient.invalidateQueries({ queryKey: ["project", slug, "object"] });
  // The server function itself failing (offline, 5xx, expired session) must not leave the
  // skeleton up forever.
  if (isError) return <RepositoryStatusMessage status="unavailable" onRetry={retry} />;
  if (!data) return <ProjectFileViewSkeleton name={name} />;
  if (data.status === "not_found") throw notFound();
  if (data.status !== "ready" || data.node.kind !== "blob")
    return (
      <RepositoryStatusMessage
        status={data.status === "ready" ? "unavailable" : data.status}
        onRetry={retry}
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
      downloadUrl={projectFileDownloadUrl(projectId, path)}
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

  function renderCrumb(crumb: (typeof links)[number], index: number, withLeadingChevron: boolean) {
    return (
      <Fragment key={index}>
        {withLeadingChevron && (
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-quaternary" />
        )}
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

  // The bold PageHeader heading is the final trail entry; this chevron is its separator.
  const headingSeparator = (
    <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-quaternary" />
  );

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
        {mobileLinks.map((crumb, index) =>
          renderCrumb(crumb, index, mobileLinks.length < links.length),
        )}
        {headingSeparator}
      </nav>
      <nav
        aria-label={m.project_tree_files()}
        className="hidden min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap text-sm text-tertiary sm:flex"
      >
        {links.map((crumb, index) => renderCrumb(crumb, index, index > 0))}
        {headingSeparator}
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
  // The listing renders from the tree at once; last commits fill in when their request lands.
  const { data: history } = useQuery(projectDirectoryCommitsQuery(slug, path, treeSha));
  const commits: Record<string, LastCommit> = history?.status === "ready" ? history.commits : {};
  const latest = history?.status === "ready" ? history.latest : null;
  const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  // Proportional columns, as GitHub's listing has them: a name keeps its full width until it
  // would actually collide with the commit message, instead of truncating at a fixed width.
  const rowClassName =
    "grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_4.5rem] items-center gap-3 px-4 py-2.5 outline-focus-ring hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2 sm:grid-cols-[1.25rem_minmax(0,2fr)_minmax(0,3fr)_4.5rem]";
  return (
    <div className="overflow-hidden rounded-xl border border-secondary">
      {/* Held open while loading so the rows below do not jump when the commit arrives. */}
      {(!history || latest) && (
        <div
          aria-busy={!history}
          className="flex h-12 min-w-0 items-center gap-3 border-b border-secondary bg-secondary px-4"
        >
          {latest ? (
            <>
              <span className="flex shrink-0 -space-x-1.5">
                {latest.people.slice(0, 3).map((person) => (
                  <Avatar
                    key={person.name}
                    size="xs"
                    src={person.avatarUrl ?? undefined}
                    initials={avatarInitial(person.name)}
                    contentClassName={avatarToneClassName(person.name)}
                    className="ring-2 ring-bg-secondary"
                    alt=""
                  />
                ))}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-tertiary">
                <span className="font-medium text-primary">
                  {latest.people.map((person) => person.name).join(", ")}
                </span>{" "}
                {latest.message}
              </span>
              <a
                href={`https://github.com/${fullName}/commit/${latest.sha}`}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 rounded font-mono text-xs text-tertiary outline-focus-ring hover:text-primary hover:underline focus-visible:outline-2"
              >
                {latest.sha.slice(0, 7)}
              </a>
              {latest.date && (
                <RelativeTime
                  value={latest.date}
                  plain
                  className="shrink-0 text-xs text-tertiary"
                />
              )}
            </>
          ) : (
            <span className="h-2.5 w-64 max-w-full animate-pulse rounded bg-tertiary motion-reduce:animate-none" />
          )}
        </div>
      )}
      <ul className="divide-y divide-secondary">
        {path !== "" && (
          <li>
            <Link
              to="/projects/$projectSlug/tree/$"
              params={{ projectSlug: slug, _splat: parentPath }}
              className={cn(rowClassName, "text-tertiary")}
            >
              <Folder aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
              <span className="col-span-2 text-sm sm:col-span-3">{m.project_tree_parent()}</span>
            </Link>
          </li>
        )}
        {entries.length === 0 ? (
          <li className="px-4 py-16 text-center text-sm text-tertiary">{m.project_tree_empty()}</li>
        ) : (
          entries.map((entry) => {
            const lastCommit = commits[entry.path] ?? null;
            const content = (
              <>
                {entry.type === "dir" ? (
                  <Folder aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
                ) : (
                  <File02 aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
                )}
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn(
                      "truncate text-sm text-primary",
                      entry.type === "dir" && "font-medium",
                    )}
                  >
                    {entry.name}
                  </span>
                  {!isBrowsable(entry.type) && (
                    <ArrowUpRight
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-quaternary"
                    />
                  )}
                </span>
                {lastCommit ? (
                  <a
                    href={`https://github.com/${fullName}/commit/${lastCommit.sha}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hidden min-w-0 truncate text-xs text-tertiary outline-focus-ring hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2 sm:block"
                  >
                    {lastCommit.message.split("\n")[0]}
                  </a>
                ) : (
                  <span className="hidden min-w-0 sm:block" />
                )}
                <span className="text-right text-xs text-tertiary">
                  {lastCommit?.date && <RelativeTime value={lastCommit.date} plain />}
                </span>
              </>
            );
            return (
              <li key={entry.path}>
                {isBrowsable(entry.type) ? (
                  <Link
                    to="/projects/$projectSlug/tree/$"
                    params={{ projectSlug: slug, _splat: entry.path }}
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
