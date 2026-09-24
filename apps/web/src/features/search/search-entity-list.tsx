import { useMemo, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Hash01 as Hash } from "@untitledui/icons";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { Badge } from "#src/components/base/badges/badges";
import { AgentDisplayAvatar } from "#src/features/agents/agent-activity-avatar";
import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import { useLiveAgents } from "#src/features/agents/workspace-agents-realtime";
import { computerIcon } from "#src/features/computers/computer-identity";
import { conversationRoute } from "#src/features/conversations/last-conversation";
import { m } from "#src/paraglide/messages";
import type { SearchEntity } from "./search-entities";

const ROW_CLASS =
  "flex min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 outline-focus-ring transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2";

/**
 * An entity's row as a link to where it opens: a channel itself; the viewer's own Agent its
 * direct messages (the Web opens an Agent's DM only for its owner), any other Agent its profile;
 * a Computer its page. Each branch is its own `Link`, so the router checks every destination.
 */
function EntityLink({ entity, children }: { entity: SearchEntity; children: ReactNode }) {
  const shared = { "data-search-entity": `${entity.kind}:${entity.id}`, className: ROW_CLASS };
  switch (entity.kind) {
    case "channel":
      return (
        <Link {...conversationRoute({ channelId: entity.id })} {...shared}>
          {children}
        </Link>
      );
    case "computer":
      return (
        <Link to="/computers/$computerId" params={{ computerId: entity.id }} {...shared}>
          {children}
        </Link>
      );
    case "agent":
      return entity.ownedByCurrentUser ? (
        <Link {...conversationRoute({ agentId: entity.id })} {...shared}>
          {children}
        </Link>
      ) : (
        <Link to="/agents" search={{ profile: formatAgentProfileParam(entity.id) }} {...shared}>
          {children}
        </Link>
      );
  }
}

const KIND_LABEL: Record<SearchEntity["kind"], () => string> = {
  channel: () => m.search_entity_channel(),
  computer: () => m.search_entity_computer(),
  agent: () => m.search_entity_agent(),
};

/** The channels, Computers and Agents a query names, listed above the messages. */
export function SearchEntityList({ entities }: { entities: readonly SearchEntity[] }) {
  const liveAgents = useLiveAgents();
  const displays = useMemo(
    () => new Map(liveAgents.map((agent) => [agent.id, agent.display])),
    [liveAgents],
  );
  return (
    <section
      aria-labelledby="search-entities-heading"
      className="flex flex-col gap-2 px-4 pt-4 sm:px-6"
    >
      <h2 id="search-entities-heading" className="text-sm font-semibold text-secondary">
        {m.search_entities_heading()}
      </h2>
      <ul className="flex flex-col gap-1">
        {entities.map((entity) => (
          <li key={`${entity.kind}:${entity.id}`}>
            <EntityLink entity={entity}>
              <EntityMark entity={entity} display={displays.get(entity.id)} />
              <span className="min-w-0 truncate text-sm font-semibold text-primary">
                {entity.kind === "channel" ? `#${entity.name}` : entity.name}
              </span>
              <Badge size="sm" color="gray" type="modern" className="shrink-0">
                {KIND_LABEL[entity.kind]()}
              </Badge>
              {entity.kind === "channel" && entity.archived && (
                <Badge size="sm" color="gray" type="modern" className="shrink-0">
                  {m.search_archived()}
                </Badge>
              )}
              <span className="min-w-0 truncate text-xs text-tertiary">
                {entitySubtitle(entity)}
              </span>
            </EntityLink>
          </li>
        ))}
      </ul>
    </section>
  );
}

function entitySubtitle(entity: SearchEntity): string {
  switch (entity.kind) {
    case "channel":
      return entity.description;
    case "computer":
      return entity.hostname;
    case "agent":
      return `@${entity.handle}`;
  }
}

/** The row's leading mark: the channel icon, the Computer's icon, an Agent's live avatar. */
function EntityMark({
  entity,
  display,
}: {
  entity: SearchEntity;
  display: AgentDisplaySnapshot | undefined;
}) {
  if (entity.kind === "agent") {
    // The row's own text names the Agent; the avatar only adds its status dot.
    return (
      <span aria-hidden="true" className="shrink-0">
        <AgentDisplayAvatar name={entity.name} src={entity.avatarUrl} display={display} size="xs" />
      </span>
    );
  }
  const Icon =
    entity.kind === "channel"
      ? Hash
      : computerIcon({
          kind: entity.computerKind,
          name: entity.hostname,
          displayName: entity.name,
        });
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary text-fg-quaternary"
    >
      <Icon className="size-4" />
    </span>
  );
}
