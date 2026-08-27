import { createFileRoute } from "@tanstack/react-router";

import { AgentsContent } from "@/components/agents-content";

export const Route = createFileRoute("/_app/")({
  component: AgentsContent,
});
