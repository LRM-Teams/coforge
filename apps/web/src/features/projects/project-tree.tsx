import { Fragment, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  File02,
  Folder,
} from "@untitledui/icons";
import { Button as AriaButton, Disclosure, DisclosurePanel, Heading } from "react-aria-components";
import { ButtonGroup, ButtonGroupItem } from "@/components/base/button-group/button-group";
import { Button } from "@/components/base/buttons/button";
import { PageHeader } from "@/components/layout/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { CodeBlockStatic } from "@/features/records/report-editor/code-block-static";
import { ContentEditor } from "@/features/records/report-editor/content-editor";
import { formatFileSize, getFileExtension } from "@/features/records/report-editor/utils/file-meta";
import { extensionToLanguage } from "@/features/records/report-editor/utils/preview";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import type { getProject, getProjectPath } from "./projects.functions";
import { RepositoryStatusMessage } from "./repository-status";

type Project = NonNullable<Awaited<ReturnType<typeof getProject>>>;
// The route's loader already throws notFound() for a "not_found" path, so the component
// only ever receives the remaining statuses.
type PathResult = Exclude<Awaited<ReturnType<typeof getProjectPath>>, { status: "not_found" }>;
type FileType = "file" | "dir" | "symlink" | "submodule";
type Entry = { name: string; path: string; type: FileType };
type Level = { path: string; entries: Entry[] };

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const crumbLinkClassName =
  "max-w-32 shrink-0 truncate rounded p-1 outline-focus-ring hover:text-primary hover:underline focus-visible:outline-2";

export function ProjectTree({
  project,
  repository,
  path,
}: {
  project: Project;
  repository: PathResult;
  path: string;
}) {
  const segments = path === "" ? [] : path.split("/");

  if (repository.status !== "ready") {
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
          <RepositoryStatusMessage status={repository.status} />
        </div>
      </main>
    );
  }

  const { fullName, defaultBranch, ancestors, node } = repository;
  const heading = segments.at(-1) ?? defaultBranch;
  const githubUrl = buildGithubUrl(fullName, defaultBranch, path, node.kind);
  const levels: Level[] =
    node.kind === "tree" ? [...ancestors, { path, entries: node.entries }] : ancestors;

  return (
    <main className="flex h-svh min-w-0 flex-col bg-primary">
      <PageHeader
        heading={heading}
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
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {node.kind === "tree" ? (
            <TreeBody
              projectSlug={project.slug}
              path={path}
              entries={node.entries}
              fullName={fullName}
              defaultBranch={defaultBranch}
            />
          ) : (
            <BlobBody
              name={node.name}
              byteSize={node.byteSize}
              text={node.text}
              githubUrl={githubUrl}
            />
          )}
        </div>
        <aside className="shrink-0 lg:w-72 lg:overflow-y-auto lg:border-l lg:border-secondary">
          <Disclosure className="mx-4 mb-4 rounded-xl border border-secondary sm:mx-6 sm:mb-6 lg:hidden">
            {({ isExpanded }) => (
              <>
                <Heading>
                  <AriaButton
                    slot="trigger"
                    className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium text-primary outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2"
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
                <DisclosurePanel className="max-h-[50vh] overflow-y-auto border-t border-secondary px-3 py-2">
                  <FileTree projectSlug={project.slug} levels={levels} currentPath={path} />
                </DisclosurePanel>
              </>
            )}
          </Disclosure>
          <div className="hidden lg:block lg:px-3 lg:py-2">
            <h2 className="px-3 pt-2 pb-2 text-xs font-semibold text-quaternary uppercase tracking-wide">
              {m.project_tree_files()}
            </h2>
            <FileTree projectSlug={project.slug} levels={levels} currentPath={path} />
          </div>
        </aside>
      </div>
    </main>
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

function TreeBody({
  projectSlug,
  path,
  entries,
  fullName,
  defaultBranch,
}: {
  projectSlug: string;
  path: string;
  entries: Array<Entry & { lastCommit: { sha: string; message: string; date: string } | null }>;
  fullName: string;
  defaultBranch: string;
}) {
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
                  {entry.lastCommit?.message.split("\n")[0]}
                </span>
                {entry.lastCommit?.date && (
                  <RelativeTime
                    value={entry.lastCommit.date}
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

function BlobBody({
  name,
  byteSize,
  text,
  githubUrl,
}: {
  name: string;
  byteSize: number;
  text: string | null;
  githubUrl: string;
}) {
  const isMarkdown = MARKDOWN_EXTENSIONS.has(getFileExtension(name));
  const [tab, setTab] = useState<"preview" | "source">("preview");
  return (
    <div className="overflow-hidden rounded-xl border border-secondary">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-secondary px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <File02 aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
          <span className="truncate text-sm font-medium text-primary">{name}</span>
          <span className="shrink-0 text-xs text-tertiary">{formatFileSize(byteSize)}</span>
        </div>
        {isMarkdown && text !== null && (
          <ButtonGroup
            aria-label={m.project_file_preview()}
            size="sm"
            selectedKeys={[tab]}
            disallowEmptySelection
            onSelectionChange={(keys) => {
              const next = [...keys][0];
              if (next === "preview" || next === "source") setTab(next);
            }}
          >
            <ButtonGroupItem id="preview">{m.project_file_preview()}</ButtonGroupItem>
            <ButtonGroupItem id="source">{m.project_file_source()}</ButtonGroupItem>
          </ButtonGroup>
        )}
      </div>
      {text === null ? (
        <div className="flex flex-col items-center gap-3 px-5 py-16 text-center">
          <p className="text-sm text-tertiary">{m.project_file_not_previewable()}</p>
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
        </div>
      ) : isMarkdown && tab === "preview" ? (
        <div className="min-w-0 px-6 py-4">
          <div className="mx-auto max-w-3xl">
            <ContentEditor editable={false} defaultValue={text} />
          </div>
        </div>
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <CodeBlockStatic
            language={isMarkdown ? "markdown" : extensionToLanguage(name)}
            body={text}
            className="p-4 text-sm"
          />
        </div>
      )}
    </div>
  );
}

/** Root first: `ancestors` from the server, plus (for a directory target) its own entries. */
function FileTree({
  projectSlug,
  levels,
  currentPath,
}: {
  projectSlug: string;
  levels: Level[];
  currentPath: string;
}) {
  return renderLevel(0, 0);

  function renderLevel(index: number, depth: number) {
    const level = levels[index];
    if (!level) return null;
    const expandedPath = levels[index + 1]?.path;
    const indent = 12 + depth * 16;
    if (level.entries.length === 0)
      return (
        <p className="py-1 text-xs text-tertiary" style={{ paddingLeft: indent }}>
          {m.project_tree_empty()}
        </p>
      );
    return (
      <ul className={depth === 0 ? "space-y-0.5" : undefined}>
        {level.entries.map((entry) => {
          const isExpanded = entry.type === "dir" && entry.path === expandedPath;
          const isCurrent = entry.path === currentPath;
          return (
            <li key={entry.path}>
              <Link
                to="/projects/$projectSlug/tree/$"
                params={{ projectSlug, _splat: entry.path }}
                aria-current={isCurrent ? "page" : undefined}
                style={{ paddingLeft: indent }}
                className={cn(
                  "flex min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-sm outline-focus-ring focus-visible:outline-2",
                  isCurrent
                    ? "bg-sidebar-accent font-semibold text-brand-secondary"
                    : "text-tertiary hover:bg-primary_hover",
                )}
              >
                {entry.type === "dir" ? (
                  isExpanded ? (
                    <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
                  ) : (
                    <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
                  )
                ) : (
                  <span className="inline-block size-3.5 shrink-0" aria-hidden="true" />
                )}
                {entry.type === "dir" ? (
                  <Folder aria-hidden="true" className="size-4 shrink-0" />
                ) : (
                  <File02 aria-hidden="true" className="size-4 shrink-0" />
                )}
                <span className="truncate">{entry.name}</span>
              </Link>
              {isExpanded && renderLevel(index + 1, depth + 1)}
            </li>
          );
        })}
      </ul>
    );
  }
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
