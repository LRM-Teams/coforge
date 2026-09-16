import { Suspense, useState, type ReactNode } from "react";
import { Await, Link, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  ArrowUpRight,
  File02,
  Folder,
  GitBranch01,
  Hash01,
  Plus,
  Settings01,
} from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { ButtonUtility } from "@/components/base/buttons/button-utility";
import { PageHeader } from "@/components/layout/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { CreateChannelDialog } from "@/features/conversations/create-channel-dialog";
import { createPublicChannel } from "@/features/conversations/channels.functions";
import { m } from "@/paraglide/messages";
import type { getProject, getProjectRepository } from "./projects.functions";
import { ProjectSettingsDialog } from "./project-settings-dialog";

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <main className="flex h-svh min-w-0 flex-col bg-primary">
      <PageHeader
        heading={project.name}
        meta={
          <ButtonUtility
            icon={Settings01}
            color="tertiary"
            aria-label={m.project_settings()}
            tooltip={m.project_settings()}
            onClick={() => setSettingsOpen(true)}
            className="shrink-0"
          />
        }
        leading={
          <Link
            to="/projects"
            aria-label={m.project_back()}
            className="shrink-0 rounded-lg p-2 text-tertiary outline-focus-ring hover:bg-primary_hover focus-visible:outline-2"
          >
            <ArrowLeft aria-hidden="true" className="size-5" />
          </Link>
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
                        <Hash01 aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
                          {conversation.channelName}
                        </span>
                        <span className="shrink-0 text-xs text-tertiary">
                          {m.project_member_count({ count: conversation._count.members })}
                        </span>
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
            <Await promise={repository}>{(data) => <RepositoryContents data={data} />}</Await>
          </Suspense>
        </div>
      </div>
      {settingsOpen && (
        <ProjectSettingsDialog project={project} onClose={() => setSettingsOpen(false)} />
      )}
      {creating && (
        <CreateChannelDialog
          open
          onOpenChange={setCreating}
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

function RepositoryContents({ data }: { data: Repository }) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  if (data.status !== "ready") {
    const text =
      data.status === "unlinked"
        ? m.project_no_repository()
        : data.status === "denied"
          ? m.project_repository_denied()
          : m.project_repository_unavailable();
    return (
      <>
        <RepositorySection title={m.project_commits()}>
          <div className="flex min-h-52 flex-col items-center justify-center gap-3 px-5 py-8 text-center">
            <p className="text-sm text-tertiary">{text}</p>
            {data.status !== "unlinked" && (
              <>
                <Link
                  to="/settings"
                  search={{ section: "integrations" }}
                  className="text-sm font-medium text-brand-secondary hover:underline"
                >
                  {m.project_github_settings()}
                </Link>
                <Button
                  size="sm"
                  color="secondary"
                  isLoading={retrying}
                  onPress={async () => {
                    setRetrying(true);
                    try {
                      await router.invalidate({ sync: true });
                    } finally {
                      setRetrying(false);
                    }
                  }}
                >
                  {m.project_retry()}
                </Button>
              </>
            )}
          </div>
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
  return (
    <>
      <RepositorySection title={m.project_commits()} meta={branch}>
        {data.commits.length ? (
          <ul className="divide-y divide-secondary">
            {data.commits.map((commit) => (
              <li key={commit.sha}>
                <a
                  href={`${base}/commit/${commit.sha}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block px-4 py-3 outline-focus-ring hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2"
                >
                  <p className="truncate text-sm font-medium text-primary">
                    {commit.message.split("\n")[0]}
                  </p>
                  <p className="mt-1 flex min-w-0 gap-2 text-xs text-tertiary">
                    <span className="truncate">{commit.author}</span>
                    <span className="font-mono">{commit.sha.slice(0, 7)}</span>
                    {commit.date && (
                      <time className="ml-auto shrink-0" dateTime={commit.date}>
                        {commit.date.slice(0, 10)}
                      </time>
                    )}
                  </p>
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
          <ul className="divide-y divide-secondary">
            {[...data.files]
              .sort(
                (a, b) =>
                  Number(b.type === "dir") - Number(a.type === "dir") ||
                  a.name.localeCompare(b.name),
              )
              .map((file) => (
                <li key={file.path}>
                  <a
                    href={`${base}/${file.type === "dir" ? "tree" : "blob"}/${encodeURIComponent(data.defaultBranch)}/${file.path.split("/").map(encodeURIComponent).join("/")}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-w-0 items-center gap-3 px-4 py-3 outline-focus-ring hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2"
                  >
                    {file.type === "dir" ? (
                      <Folder aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
                    ) : (
                      <File02 aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm text-primary">
                      {file.name}
                    </span>
                    <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 text-quaternary" />
                  </a>
                </li>
              ))}
          </ul>
        ) : (
          <p className="px-4 py-16 text-center text-sm text-tertiary">{m.project_files_empty()}</p>
        )}
      </RepositorySection>
    </>
  );
}
