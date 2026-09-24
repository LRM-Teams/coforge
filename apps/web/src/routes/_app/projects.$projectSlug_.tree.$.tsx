import { createFileRoute, notFound } from "@tanstack/react-router";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { ProjectsPending } from "#src/features/projects/projects-content";
import { ProjectTree } from "#src/features/projects/project-tree";
import {
  projectObjectQuery,
  projectQuery,
  projectTreeQuery,
} from "#src/features/projects/project-tree-queries";

export const Route = createFileRoute("/_app/projects/$projectSlug_/tree/$")({
  // The markdown Preview toggle renders ContentEditor (TipTap), which must not SSR.
  ssr: "data-only",
  loader: async ({ params, context: { queryClient } }) => {
    const slug = params.projectSlug;
    const path = params._splat ?? "";
    // Only the first visit waits here: afterwards both are cache hits ("static" = any cached
    // value will do; the mounted page revalidates the tree on its own), so moving between
    // files never blocks on the loader and the page shell stays mounted.
    const [project, tree] = await Promise.all([
      queryClient.query({ ...projectQuery(slug), staleTime: "static" }),
      queryClient.query({ ...projectTreeQuery(slug), staleTime: "static" }),
    ]);
    if (!project) throw notFound();
    if (tree.status === "ready") {
      const entry = path === "" ? undefined : tree.entries.find((item) => item.path === path);
      if (path !== "" && !entry && !tree.truncated) throw notFound();
      // Started, not awaited: the content pane shows its own skeleton while this is in flight,
      // and intent preloading (hover) usually finishes it before the click.
      if (entry?.type === "file")
        void queryClient.query(projectObjectQuery(slug, path, entry.sha)).catch(() => {});
    }
  },
  pendingComponent: ProjectsPending,
  errorComponent: PageLoadError,
  component: ProjectTreeRoute,
});

function ProjectTreeRoute() {
  const { projectSlug, _splat } = Route.useParams();
  return <ProjectTree slug={projectSlug} path={_splat ?? ""} />;
}
