import { useEffect } from "react";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";

const computersRoute = getRouteApi("/_app/computers");

export const Route = createFileRoute("/_app/computers/")({
  component: ComputersIndexPage,
});

function ComputersIndexPage() {
  const { computers } = computersRoute.useLoaderData();
  const navigate = Route.useNavigate();
  const computerId = computers[0]?.id;
  useEffect(() => {
    // Mobile starts with the list. Desktop retains its initial selection.
    const desktop = window.matchMedia("(min-width: 768px)");
    const selectFirst = () => {
      if (!desktop.matches || !computerId) return;
      void navigate({ to: "/computers/$computerId", params: { computerId }, replace: true });
    };
    selectFirst();
    desktop.addEventListener("change", selectFirst);
    return () => desktop.removeEventListener("change", selectFirst);
  }, [computerId, navigate]);
  // The layout owns the list and the no-Computers state.
  return null;
}
