import { createFileRoute, notFound } from "@tanstack/react-router";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { ProjectsPending } from "#src/features/projects/projects-content";
import { ProjectSettingsPage } from "#src/features/projects/project-settings";
import { getProject } from "#src/features/projects/projects.functions";
import { m } from "#src/paraglide/messages";

export const Route = createFileRoute("/_app/projects/$projectSlug_/settings")({
  loader: async ({ params }) => {
    const project = await getProject({ data: { slug: params.projectSlug } });
    if (!project) throw notFound();
    return project;
  },
  pendingComponent: () => <ProjectsPending heading={m.project_settings()} />,
  errorComponent: PageLoadError,
  component: ProjectSettingsRoute,
});

function ProjectSettingsRoute() {
  const project = Route.useLoaderData();
  return <ProjectSettingsPage key={project.id} project={project} />;
}
