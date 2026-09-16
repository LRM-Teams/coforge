import { createFileRoute } from "@tanstack/react-router";
import { notFound } from "@tanstack/react-router";
import { getProject } from "../../features/projects/projects.functions";

export const Route = createFileRoute("/_app/projects/$projectSlug")({
  loader: async ({ params }) => {
    const project = await getProject({ data: { slug: params.projectSlug } });
    if (!project) throw notFound();
    return { project };
  },
  component: ProjectPage,
});

function ProjectPage() {
  const { project } = Route.useLoaderData();
  return (
    <main className="flex min-h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-xl font-semibold text-primary">{project.name}</h1>
        <p className="mt-1 text-sm text-tertiary">{project.slug}</p>
      </header>
      <section className="rounded-lg border border-subtle p-4">
        <h2 className="font-medium text-primary">GitHub repository</h2>
        <a
          className="mt-2 block text-sm text-link hover:underline"
          href={project.githubHtmlUrl}
          target="_blank"
          rel="noreferrer"
        >
          {project.githubFullName}
        </a>
      </section>
    </main>
  );
}
