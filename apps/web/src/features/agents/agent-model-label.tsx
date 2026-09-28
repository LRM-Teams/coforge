import { ClientOnly } from "@tanstack/react-router";

import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { useShowAgentModel } from "#src/features/settings/show-agent-model";
import { useAgentModel } from "./agent-models";
import { useCurrentWorkspaceId } from "./workspace-agents-realtime";

/** An Agent's configured model beside its name in chat (Settings → Show agent model). The model
 * comes from a React Query read and the setting from a device preference, so a server render has
 * neither: inside `ClientOnly` the row renders exactly as it did before this label existed, which
 * is also what the message row's static-render tests check. */
export function AgentModelLabel({ agentId, seenAt }: { agentId: string; seenAt: Date | string }) {
  return (
    <ClientOnly>
      <AgentModelLabelContent agentId={agentId} seenAt={seenAt} />
    </ClientOnly>
  );
}

/** Nothing is read while the setting is off or outside a Workspace: the model query lives in
 * `AgentModelText`, so a row without the label never subscribes to it. */
function AgentModelLabelContent({ agentId, seenAt }: { agentId: string; seenAt: Date | string }) {
  const [show] = useShowAgentModel();
  const workspaceId = useCurrentWorkspaceId();
  if (!show || !workspaceId) return null;
  return <AgentModelText agentId={agentId} workspaceId={workspaceId} seenAt={seenAt} />;
}

/** The model itself; a long id is cut, and the full one is in the tooltip on hover or focus. */
function AgentModelText({
  agentId,
  workspaceId,
  seenAt,
}: {
  agentId: string;
  workspaceId: string;
  seenAt: Date | string;
}) {
  const model = useAgentModel(workspaceId, agentId, seenAt);
  if (!model) return null;
  return (
    <Tooltip title={model}>
      <TooltipTrigger className="max-w-48 min-w-0 shrink cursor-default truncate rounded-sm text-xs text-tertiary outline-focus-ring focus-visible:outline-2">
        {model}
      </TooltipTrigger>
    </Tooltip>
  );
}
