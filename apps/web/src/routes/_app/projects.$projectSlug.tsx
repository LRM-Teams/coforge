import { createFileRoute, notFound } from "@tanstack/react-router";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { ProjectsPending } from "#src/features/projects/projects-content";
import { ProjectDetail } from "#src/features/projects/project-detail";
import { getProject, getProjectRepository } from "#src/features/projects/projects.functions";

export const Route = createFileRoute("/_app/projects/$projectSlug")({
  loader: async ({ params }) => {
    const project = await getProject({ data: { slug: params.projectSlug } });
    if (!project) throw notFound();
    return {
      project,
      repository: getProjectRepository({ data: { slug: params.projectSlug } }).catch(() => ({
        status: "unavailable" as const,
      })),
    };
  },
  pendingComponent: ProjectsPending,
  errorComponent: PageLoadError,
  component: ProjectPage,
});

function ProjectPage() {
  return <ProjectDetail {...Route.useLoaderData()} />;
}
