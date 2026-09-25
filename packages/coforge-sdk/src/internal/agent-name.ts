/**
 * Raft 1.0.32's Agent name — the public `@handle` fixed at creation and never renamed afterward:
 * lowercase alphanumerics in single-hyphen-separated segments, at most 60 characters.
 *
 * The one definition, because more than one side has to agree on it and the SDK cannot import the
 * Web app: the create/edit form schema (`apps/web/src/features/agents/agent.schemas.ts`), the
 * deletion path that builds a freed name from the bound (`agent.repositories.server.ts`), and the
 * longest public handle a message can carry as its sender (`./message-sender.ts`).
 */
export const AGENT_NAME_MAX_LENGTH = 60;

/** The Agent-name grammar: at least one lowercase alphanumeric run, further runs after single
 * hyphens. */
export const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
