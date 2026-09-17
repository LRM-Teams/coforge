import { Suspense, useState, type ReactNode } from "react";
import { Await, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle,
  Circle,
  File02,
  Folder,
  GitBranch01,
  Plus,
  Settings01,
  XCircle,
} from "@untitledui/icons";
import { Avatar } from "@/components/base/avatar/avatar";
import { Badge } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { PageHeader } from "@/components/layout/page-header";
import { RelativeTime } from "@/components/ui/relative-time";
import { Skeleton } from "@/components/ui/skeleton";
import { CreateChannelDialog } from "@/features/conversations/create-channel-dialog";
import { createPublicChannel } from "@/features/conversations/channels.functions";
import { avatarInitial, avatarToneClassName } from "@/lib/avatar-tone";
import { m } from "@/paraglide/messages";
import type { getProject, getProjectRepository } from "./projects.functions";
import { ProjectImage } from "./project-image";
import { RepositoryStatusMessage } from "./repository-status";

type Repository = Awaited<ReturnType<typeof getProjectRepository>>;

export function ProjectDetail({
  project,
  repository,
}: {
  project: NonNullable<Awaited<ReturnType<typeof getProject>>>;
  repository: Promise<Repository>;
}) {
  const router = useRouter();
  const create = useServerFn(createPublicChannel);
  const [creating, setCreating] = useState(false);
  return (
    <main className="flex h-svh min-w-0 flex-col bg-primary">
      <PageHeader
        heading={project.name}
        meta={
          <Link
            to="/projects/$projectSlug/settings"
            params={{ projectSlug: project.slug }}
            aria-label={m.project_settings()}
            className="shrink-0 rounded-lg p-2 text-tertiary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
          >
            <Settings01 aria-hidden="true" className="size-5" />
          </Link>
        }
        leading={
          <>
            <Link
              to="/projects"
              aria-label={m.project_back()}
              className="shrink-0 rounded-lg p-2 text-tertiary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
            >
              <ArrowLeft aria-hidden="true" className="size-5" />
            </Link>
            <ProjectImage name={project.name} url={project.iconUrl} />
          </>
        }
        actions={
          project.githubFullName && (
            <a
              href={`https://github.com/${project.githubFullName}`}
              target="_blank"
              rel="noreferrer"
              aria-label={project.githubFullName}
              className="flex items-center gap-1 text-sm text-tertiary hover:text-primary"
            >
              GitHub
              <ArrowUpRight aria-hidden="true" className="size-4" />
            </a>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {project.description && (
          <p className="mb-6 whitespace-pre-wrap break-words text-sm text-tertiary">
            {project.description}
          </p>
        )}
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="order-1 min-w-0 lg:order-2">
            <div className="mb-3 flex min-h-9 items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-primary">{m.project_discussions()}</h2>
              <Button
                size="sm"
                color="secondary"
                iconLeading={Plus}
                onPress={() => setCreating(true)}
              >
                {m.project_discussion_create()}
              </Button>
            </div>
            <div className="min-h-52 overflow-hidden rounded-xl border border-secondary">
              {project.conversations.length ? (
                <ul className="divide-y divide-secondary">
                  {project.conversations.map((conversation) => (
                    <li key={conversation.id}>
                      <Link
                        to="/messages/channels/$channelId"
                        params={{ channelId: conversation.id }}
                        className="flex min-w-0 items-center gap-3 px-4 py-4 outline-focus-ring hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2"
                      >
                        <Avatar
                          size="xs"
                          src={conversation.lastSender?.avatarUrl ?? undefined}
                          initials={
                            conversation.lastSender
                              ? avatarInitial(conversation.lastSender.name)
                              : undefined
                          }
                          contentClassName={
                            conversation.lastSender
                              ? avatarToneClassName(conversation.lastSender.name)
                              : undefined
                          }
                          alt=""
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-primary">
                            {conversation.channelName}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-tertiary">
                            {conversation.lastSender
                              ? `${conversation.lastSender.name} · ${m.project_message_count({ count: conversation.messageCount })}`
                              : m.project_no_messages()}
                          </span>
                        </span>
                        <RelativeTime
                          value={conversation.lastActivityAt}
                          plain
                          className="shrink-0 text-xs text-tertiary"
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-16 text-center text-sm text-tertiary">
                  {m.project_discussions_empty()}
                </p>
              )}
            </div>
          </section>
          <Suspense
            fallback={
              <>
                <RepositorySection title={m.project_commits()}>
                  <RepositoryLoading />
                </RepositorySection>
                <RepositorySection title={m.project_files()} files>
                  <RepositoryLoading />
                </RepositorySection>
              </>
            }
          >
            <Await promise={repository}>
              {(data) => <RepositoryContents data={data} projectSlug={project.slug} />}
            </Await>
          </Suspense>
        </div>
      </div>
      {creating && (
        <CreateChannelDialog
          open
          onOpenChange={setCreating}
          defaultName={project.slug}
          onCreate={async (name) => {
            await create({ data: { name, projectId: project.id } });
            await router.invalidate({ sync: true });
          }}
        />
      )}
    </main>
  );
}

function RepositorySection({
  title,
  files = false,
  children,
  meta,
}: {
  title: string;
  files?: boolean;
  children: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <section className={files ? "order-3 min-w-0 lg:col-span-2" : "order-2 min-w-0 lg:order-1"}>
      <div className="mb-3 flex min-h-9 items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-primary">{title}</h2>
        {meta}
      </div>
      <div className="min-h-52 overflow-hidden rounded-xl border border-secondary">{children}</div>
    </section>
  );
}

function RepositoryLoading() {
  return (
    <div aria-busy="true" className="space-y-5 p-4">
      <span role="status" className="sr-only">
        {m.project_repository_loading()}
      </span>
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-5 w-3/4" />
      ))}
    </div>
  );
}

function RepositoryContents({ data, projectSlug }: { data: Repository; projectSlug: string }) {
  if (data.status !== "ready") {
    return (
      <>
        <RepositorySection title={m.project_commits()}>
          <RepositoryStatusMessage status={data.status} />
        </RepositorySection>
        <RepositorySection title={m.project_files()} files>
          <p className="px-5 py-16 text-center text-sm text-tertiary">
            {m.project_files_unavailable()}
          </p>
        </RepositorySection>
      </>
    );
  }
  const base = `https://github.com/${data.fullName}`;
  const branch = (
    <span className="flex min-w-0 items-center gap-1 text-xs text-tertiary">
      <GitBranch01 aria-hidden="true" className="size-4 shrink-0" />
      <span className="truncate">{data.defaultBranch}</span>
    </span>
  );
  const latestCommit = data.commits[0];
  return (
    <>
      <RepositorySection title={m.project_commits_to({ branch: data.defaultBranch })}>
        {data.commits.length ? (
          <ul className="divide-y divide-secondary">
            {data.commits.map((commit) => (
              <li key={commit.sha}>
                <a
                  href={`${base}/commit/${commit.sha}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-w-0 items-center gap-3 px-4 py-3 outline-focus-ring hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2"
                >
                  <span className="flex shrink-0 -space-x-1.5">
                    <CommitIdentity
                      name={commit.author}
                      email={commit.authorEmail}
                      role={m.project_commit_role_author()}
                      avatarUrl={commit.authorAvatarUrl}
                    />
                    {commit.coAuthors.slice(0, 2).map((coAuthor) => (
                      <CommitIdentity
                        key={coAuthor.name}
                        name={coAuthor.name}
                        email={coAuthor.email}
                        role={m.project_commit_role_coauthored()}
                        avatarUrl={coAuthor.avatarUrl}
                      />
                    ))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-primary">
                      {commit.message.split("\n")[0]}
                    </p>
                    <p className="mt-0.5 flex min-w-0 gap-2 text-xs text-tertiary">
                      <span className="truncate">
                        {[
                          commit.author,
                          ...commit.coAuthors.map((coAuthor) => coAuthor.name),
                          ...(commit.committer ? [commit.committer] : []),
                        ].join(", ")}
                      </span>
                      <span className="shrink-0 font-mono">{commit.sha.slice(0, 7)}</span>
                    </p>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {commit.verified && (
                      <Badge size="sm" color="success">
                        {m.project_commit_verified()}
                      </Badge>
                    )}
                    {commit.date && (
                      <RelativeTime value={commit.date} plain className="text-xs text-tertiary" />
                    )}
                    <CommitChecksIcon checks={commit.checks} />
                  </span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-16 text-center text-sm text-tertiary">
            {m.project_commits_empty()}
          </p>
        )}
      </RepositorySection>
      <RepositorySection title={m.project_files()} files meta={branch}>
        {data.files.length ? (
          <>
            {latestCommit && (
              <div className="flex min-w-0 items-center gap-3 border-b border-secondary px-4 py-3">
                <Avatar
                  size="xs"
                  src={latestCommit.authorAvatarUrl ?? undefined}
                  initials={avatarInitial(latestCommit.author)}
                  contentClassName={avatarToneClassName(latestCommit.author)}
                  alt=""
                />
                <span className="min-w-0 flex-1 truncate text-sm text-tertiary">
                  <span className="font-medium text-primary">{latestCommit.author}</span>{" "}
                  {latestCommit.message.split("\n")[0]}
                </span>
                <span className="shrink-0 font-mono text-xs text-tertiary">
                  {latestCommit.sha.slice(0, 7)}
                </span>
                {latestCommit.date && (
                  <RelativeTime
                    value={latestCommit.date}
                    plain
                    className="shrink-0 text-xs text-tertiary"
                  />
                )}
                <a
                  href={`${base}/commits/${encodeURIComponent(data.defaultBranch)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="shrink-0 text-xs font-medium text-brand-secondary hover:underline"
                >
                  {m.project_view_commits()}
                </a>
              </div>
            )}
            <ul className="divide-y divide-secondary">
              {[...data.files]
                .sort(
                  (a, b) =>
                    Number(b.type === "dir") - Number(a.type === "dir") ||
                    a.name.localeCompare(b.name),
                )
                .map((file) => {
                  const nameLinkClassName =
                    "flex min-w-0 max-w-[40%] shrink-0 items-center gap-3 outline-focus-ring focus-visible:outline-2 focus-visible:-outline-offset-2";
                  return (
                    <li key={file.path}>
                      <div className="flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-primary_hover">
                        {file.type === "dir" || file.type === "file" ? (
                          <Link
                            to="/projects/$projectSlug/tree/$"
                            params={{ projectSlug, _splat: file.path }}
                            className={nameLinkClassName}
                          >
                            <Folder aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
                            <span className="min-w-0 truncate text-sm text-primary">
                              {file.name}
                            </span>
                          </Link>
                        ) : (
                          // Reached only for "symlink"/"submodule" — neither is "dir", so this is always a blob URL.
                          <a
                            href={`${base}/blob/${encodeURIComponent(data.defaultBranch)}/${file.path.split("/").map(encodeURIComponent).join("/")}`}
                            target="_blank"
                            rel="noreferrer"
                            className={nameLinkClassName}
                          >
                            <File02 aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
                            <span className="min-w-0 truncate text-sm text-primary">
                              {file.name}
                            </span>
                            <ArrowUpRight
                              aria-hidden="true"
                              className="size-3.5 shrink-0 text-quaternary"
                            />
                          </a>
                        )}
                        {file.lastCommit ? (
                          <a
                            href={`${base}/commit/${file.lastCommit.sha}`}
                            target="_blank"
                            rel="noreferrer"
                            className="min-w-0 flex-1 truncate text-xs text-tertiary outline-focus-ring hover:underline focus-visible:outline-2 focus-visible:-outline-offset-2"
                          >
                            {file.lastCommit.message.split("\n")[0]}
                          </a>
                        ) : (
                          <span className="min-w-0 flex-1" />
                        )}
                        {file.lastCommit?.date && (
                          <RelativeTime
                            value={file.lastCommit.date}
                            plain
                            className="shrink-0 text-xs text-tertiary"
                          />
                        )}
                      </div>
                    </li>
                  );
                })}
            </ul>
          </>
        ) : (
          <p className="px-4 py-16 text-center text-sm text-tertiary">{m.project_files_empty()}</p>
        )}
      </RepositorySection>
    </>
  );
}

function CommitIdentity({
  name,
  email,
  role,
  avatarUrl,
}: {
  name: string;
  email: string | null;
  role: string;
  avatarUrl: string | null;
}) {
  return (
    <Tooltip title={`${name} · ${role}`} description={email ?? undefined}>
      <TooltipTrigger className="flex rounded-full">
        <Avatar
          size="xs"
          src={avatarUrl ?? undefined}
          initials={avatarInitial(name)}
          contentClassName={avatarToneClassName(name)}
          className="ring-2 ring-primary"
          alt=""
        />
      </TooltipTrigger>
    </Tooltip>
  );
}

function CommitChecksIcon({ checks }: { checks: "success" | "failure" | "pending" | null }) {
  if (checks === "success")
    return (
      <span className="inline-flex items-center">
        <CheckCircle aria-hidden="true" className="size-4 text-success-primary" />
        <span className="sr-only">{m.project_checks_success()}</span>
      </span>
    );
  if (checks === "failure")
    return (
      <span className="inline-flex items-center">
        <XCircle aria-hidden="true" className="size-4 text-error-primary" />
        <span className="sr-only">{m.project_checks_failure()}</span>
      </span>
    );
  if (checks === "pending")
    return (
      <span className="inline-flex items-center">
        <Circle aria-hidden="true" className="size-2 fill-current text-quaternary" />
        <span className="sr-only">{m.project_checks_pending()}</span>
      </span>
    );
  return null;
}
