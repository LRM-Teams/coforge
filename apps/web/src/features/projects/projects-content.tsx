import { useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Folder, Plus } from "@untitledui/icons";
import { Button } from "@/components/base/buttons/button";
import { PageHeader } from "@/components/layout/page-header";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { m } from "@/paraglide/messages";
import { CreateProjectDialog } from "./create-project-dialog";
import type { listProjects } from "./projects.functions";

export function ProjectsContent({
  projects,
}: {
  projects: Awaited<ReturnType<typeof listProjects>>;
}) {
  const [creating, setCreating] = useState(false);
  const router = useRouter();
  return (
    <main className="flex h-svh min-w-0 flex-col bg-primary">
      <PageHeader
        heading={m.projects_title()}
        actions={
          <Button size="sm" iconLeading={Plus} onPress={() => setCreating(true)}>
            {m.project_create()}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        {projects.length === 0 ? (
          <Empty className="min-h-64">
            <EmptyHeader>
              <EmptyMedia>
                <Folder aria-hidden="true" className="size-12 text-quaternary" />
              </EmptyMedia>
              <EmptyTitle>
                <h2>{m.projects_empty_title()}</h2>
              </EmptyTitle>
              <EmptyDescription>{m.projects_empty_description()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="divide-y divide-secondary">
            {projects.map((project) => (
              <li
                key={project.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4 first:pt-0"
              >
                <Link
                  to="/projects/$projectSlug"
                  params={{ projectSlug: project.slug }}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-4"
                >
                  <Folder aria-hidden="true" className="size-5 shrink-0 text-tertiary" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-primary">
                      {project.name}
                    </span>
                    <span className="block truncate text-sm text-tertiary">{project.slug}</span>
                  </span>
                </Link>
                <span className="text-sm text-tertiary">
                  {m.project_discussion_count({ count: project.conversations.length })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {creating && (
        <CreateProjectDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={async () => {
            await router.invalidate({ sync: true });
          }}
        />
      )}
    </main>
  );
}

export function ProjectsPending() {
  return (
    <main className="flex h-svh min-w-0 flex-col bg-primary">
      <PageHeader heading={m.projects_title()} />
      <div aria-busy="true" aria-label={m.projects_title()} className="space-y-6 px-4 py-6 sm:px-6">
        <p role="status" className="sr-only">
          {m.projects_loading()}
        </p>
        {[0, 1, 2].map((index) => (
          <div key={index} aria-hidden="true" className="flex items-center gap-3">
            <Skeleton className="size-5" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-24" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
