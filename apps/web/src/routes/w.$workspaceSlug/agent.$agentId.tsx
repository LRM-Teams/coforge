import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import {
  agentProfileTabParamSchema,
  formatAgentProfileParam,
} from "#src/features/agents/profile-panel/profile-panel-search";

export const Route = createFileRoute("/w/$workspaceSlug/agent/$agentId")({
  validateSearch: z.object({
    agentTab: agentProfileTabParamSchema,
  }),
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/w/$workspaceSlug/members",
      params: { workspaceSlug: params.workspaceSlug },
      replace: true,
      search: {
        profile: formatAgentProfileParam(params.agentId),
        agentTab: search.agentTab,
      },
    });
  },
  component: () => null,
});
