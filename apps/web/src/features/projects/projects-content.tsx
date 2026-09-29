import { useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Folder, Plus } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { PageHeader } from "#src/components/layout/page-header";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "#src/components/ui/empty";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { CreateProjectDialog } from "./create-project-dialog";
import type { listProjects } from "./projects.functions";
import { ProjectImage } from "./project-image";

export function ProjectsContent({
  projects,
}: {
  projects: Awaited<ReturnType<typeof listProjects>>;
}) {
  const [creating, setCreating] = useState(false);
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  return (
    <main className="flex h-svh min-w-0 flex-col bg-primary">
      <PageHeader
        heading={m.projects_title()}
        actions={
          <Button size="sm" color="secondary" iconLeading={Plus} onPress={() => setCreating(true)}>
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
                  to="/w/$workspaceSlug/projects/$projectSlug"
                  params={{ workspaceSlug, projectSlug: project.slug }}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-4"
                >
                  <ProjectImage name={project.name} url={project.iconUrl} />
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
