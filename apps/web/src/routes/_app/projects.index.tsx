import { createFileRoute } from "@tanstack/react-router";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { ProjectsContent, ProjectsPending } from "#src/features/projects/projects-content";
import { listProjects } from "#src/features/projects/projects.functions";

export const Route = createFileRoute("/_app/projects/")({
  loader: () => listProjects(),
  pendingComponent: ProjectsPending,
  errorComponent: PageLoadError,
  component: ProjectsPage,
});

function ProjectsPage() {
  return <ProjectsContent projects={Route.useLoaderData()} />;
}
