import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { useAgentModelName } from "#src/features/settings/agent-model-name";
import { useAgentModel } from "./agent-models";

/** An Agent's configured model beside its name in chat (Settings → Show agent model). Draws
 * nothing while the setting is off, before the models load, or for an Agent on its runtime's
 * default model. The full id is in the tooltip when a long one is cut. */
export function AgentModelLabel({ agentId }: { agentId: string }) {
  const [show] = useAgentModelName();
  const model = useAgentModel(agentId, show);
  if (!show || !model) return null;
  return (
    <Tooltip title={model}>
      <span className="max-w-48 min-w-0 shrink truncate text-xs text-tertiary">{model}</span>
    </Tooltip>
  );
}
