import { createFileRoute } from "@tanstack/react-router";
import { PageLoadError } from "@/features/errors/page-load-error";
import { ProjectsContent, ProjectsPending } from "@/features/projects/projects-content";
import { listProjects } from "@/features/projects/projects.functions";

export const Route = createFileRoute("/_app/projects/")({
  loader: () => listProjects(),
  pendingMs: 300,
  pendingMinMs: 0,
  pendingComponent: ProjectsPending,
  errorComponent: PageLoadError,
  component: ProjectsPage,
});

function ProjectsPage() {
  return <ProjectsContent projects={Route.useLoaderData()} />;
}
