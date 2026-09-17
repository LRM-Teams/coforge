/**
 * The Computer/Workspace mapping shared by every server surface that reports an Agent's runtime
 * context to the Agent itself: the launch-config response's `identity.runtimeContext`
 * (`apps/web/src/routes/api/agent-api-keys.ts`) and the workspace-info response's
 * `runtimeContext` (`apps/web/src/routes/api/agent/v1/workspace.ts`). Extracted so the two
 * surfaces can never disagree about what a Computer's name, hostname, or OS string is; see ADR
 * 0036's "Prompt versus Manual placement" table, step 3.
 */

export type AgentRuntimeContextComputer = {
  name: string;
  displayName: string;
  platform: string | null;
  osVersion: string | null;
  computerVersion: string | null;
} | null;

export type AgentRuntimeContextWorkspace = { slug: string; name: string } | null;

export type AgentRuntimeContextSource = {
  workspaceId: string;
  workspace: AgentRuntimeContextWorkspace;
  computerId: string | null;
  computer: AgentRuntimeContextComputer;
};

export type AgentRuntimeContext = {
  workspaceId?: string;
  workspaceSlug?: string;
  workspaceName?: string;
  computerId?: string;
  computerName?: string;
  computerOs?: string;
  computerVersion?: string;
  computerHostname?: string;
};

/** Same fallback as `WorkspaceMembers.list`'s `computerName`: the human-facing Computer Name,
 * falling back to the OS hostname, so surfaces never disagree. */
function computerRuntimeContextName(computer: AgentRuntimeContextComputer): string | undefined {
  return computer?.displayName.trim() || computer?.name.trim() || undefined;
}

function computerRuntimeContextOs(computer: AgentRuntimeContextComputer): string | undefined {
  const parts = [computer?.platform?.trim(), computer?.osVersion?.trim()].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Maps one Agent's Workspace and Computer to the `runtimeContext` fields, each field present only
 * when known so an older decoder degrades cleanly. Every field is optional: an Agent may have no
 * assigned Computer.
 */
export function buildAgentRuntimeContext(agent: AgentRuntimeContextSource): AgentRuntimeContext {
  const computerName = computerRuntimeContextName(agent.computer);
  const computerOs = computerRuntimeContextOs(agent.computer);
  return {
    ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
    ...(agent.workspace?.slug ? { workspaceSlug: agent.workspace.slug } : {}),
    ...(agent.workspace?.name ? { workspaceName: agent.workspace.name } : {}),
    ...(agent.computerId ? { computerId: agent.computerId } : {}),
    ...(computerName ? { computerName } : {}),
    ...(computerOs ? { computerOs } : {}),
    ...(agent.computer?.computerVersion?.trim()
      ? { computerVersion: agent.computer.computerVersion.trim() }
      : {}),
    // `Computer.name` is the OS hostname: registration sets and refreshes it on every setup, and
    // it has no rename control (`displayName` is the editable one), so it needs no column of its own.
    ...(agent.computer?.name.trim() ? { computerHostname: agent.computer.name.trim() } : {}),
  };
}
