import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import {
  agentProfileTabParamSchema,
  formatAgentProfileParam,
} from "@/features/agents/profile-panel/profile-panel-search";

const legacyDetailTabSchema = z
  .enum(["profile", "activity", "reminders", "workspace"])
  .optional()
  .catch(undefined);

export const Route = createFileRoute("/_app/agents/$agentId")({
  validateSearch: z.object({
    agentTab: agentProfileTabParamSchema,
    tab: legacyDetailTabSchema,
  }),
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/agents",
      replace: true,
      search: {
        profile: formatAgentProfileParam(params.agentId),
        agentTab: search.agentTab ?? search.tab,
      },
    });
  },
  component: () => null,
});
