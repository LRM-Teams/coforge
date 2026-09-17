import { createFileRoute, notFound } from "@tanstack/react-router";
import { PageLoadError } from "@/features/errors/page-load-error";
import { ProjectsPending } from "@/features/projects/projects-content";
import { ProjectTree } from "@/features/projects/project-tree";
import { getProject, getProjectPath } from "@/features/projects/projects.functions";

export const Route = createFileRoute("/_app/projects/$projectSlug_/tree/$")({
  // The markdown Preview toggle renders ContentEditor (TipTap), which must not SSR.
  ssr: "data-only",
  loader: async ({ params }) => {
    const path = params._splat ?? "";
    const [project, repository] = await Promise.all([
      getProject({ data: { slug: params.projectSlug } }),
      getProjectPath({ data: { slug: params.projectSlug, path } }),
    ]);
    if (!project) throw notFound();
    if (repository.status === "not_found") throw notFound();
    return { project, repository, path };
  },
  pendingMs: 300,
  pendingMinMs: 0,
  pendingComponent: ProjectsPending,
  errorComponent: PageLoadError,
  component: ProjectTreeRoute,
});

function ProjectTreeRoute() {
  const { project, repository, path } = Route.useLoaderData();
  return <ProjectTree project={project} repository={repository} path={path} />;
}
