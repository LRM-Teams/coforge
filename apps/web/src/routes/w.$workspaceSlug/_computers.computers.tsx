import { useEffect } from "react";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";

import { useBreakpoint } from "#src/hooks/use-breakpoint";

const computersRoute = getRouteApi("/w/$workspaceSlug/_computers");

export const Route = createFileRoute("/w/$workspaceSlug/_computers/computers")({
  component: ComputersIndexPage,
});

function ComputersIndexPage() {
  const { computers } = computersRoute.useLoaderData();
  const { workspaceSlug } = Route.useParams();
  const navigate = Route.useNavigate();
  const computerId = computers[0]?.id;
  const desktop = useBreakpoint("md");
  useEffect(() => {
    // Mobile starts with the list. Desktop retains its initial selection.
    if (!desktop || !computerId) return;
    void navigate({
      to: "/w/$workspaceSlug/computer/$computerId",
      params: { workspaceSlug, computerId },
      replace: true,
    });
  }, [desktop, workspaceSlug, computerId, navigate]);
  // The layout owns the list and the no-Computers state.
  return null;
}
