/**
 * The Redis key grammar the workspace-scoped caches and stores share:
 *
 *   coforge:workspace:<workspaceId>[:computer:<computerId>][:agent:<agentId>]:<name>:<version>
 *
 * with every id percent-encoded. Eight of them built the string themselves, and a drift here is
 * silent — a cache miss or a stale read rather than an error — which is what makes the grammar worth
 * naming.
 *
 * `name` and `version` are literals: the version is part of the key so a change to what is stored
 * can be rolled out by bumping it (`display:v1`, `status:v2`, `usage:v2`), and the names are what
 * each cache calls its own data.
 *
 * Keys that are not workspace-scoped keep their own spelling: the agent-skills and workspace-files
 * caches key by request id, and the message-idempotency keys are conversation-scoped.
 */
export function workspaceRedisKey(input: {
  workspaceId: string;
  computerId?: string;
  agentId?: string;
  name: string;
  version: string;
}): string {
  const segment = (value: string) => encodeURIComponent(value);
  const parts = [`coforge:workspace:${segment(input.workspaceId)}`];
  if (input.computerId !== undefined) parts.push(`computer:${segment(input.computerId)}`);
  if (input.agentId !== undefined) parts.push(`agent:${segment(input.agentId)}`);
  parts.push(`${input.name}:${input.version}`);
  return parts.join(":");
}
