import { createFileRoute, notFound } from "@tanstack/react-router";
import { PageLoadError } from "@/features/errors/page-load-error";
import { ProjectsPending } from "@/features/projects/projects-content";
import { ProjectSettingsPage } from "@/features/projects/project-settings";
import { getProject } from "@/features/projects/projects.functions";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/_app/projects/$projectSlug_/settings")({
  loader: async ({ params }) => {
    const project = await getProject({ data: { slug: params.projectSlug } });
    if (!project) throw notFound();
    return project;
  },
  pendingMs: 300,
  pendingMinMs: 0,
  pendingComponent: () => <ProjectsPending heading={m.project_settings()} />,
  errorComponent: PageLoadError,
  component: ProjectSettingsRoute,
});

function ProjectSettingsRoute() {
  const project = Route.useLoaderData();
  return <ProjectSettingsPage key={project.id} project={project} />;
}
