import { Link } from "@tanstack/react-router";
import { Hash01 as Hash } from "@untitledui/icons";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { Badge } from "#src/components/base/badges/badges";
import { AgentDisplayAvatar } from "#src/features/agents/agent-activity-avatar";
import { agentDisplay } from "#src/features/agents/agent-activity-presentation";
import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import { useAgentDisplays } from "#src/features/agents/workspace-agents-realtime";
import { computerIcon } from "#src/features/computers/computer-identity";
import { conversationRoute } from "#src/features/conversations/last-conversation";
import { m } from "#src/paraglide/messages";
import type { SearchEntity } from "./search-entities";

/** A compact row in the matches list. */
export const ENTITY_ROW_CLASS =
  "flex min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 outline-focus-ring transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2";

/** A card on the empty page's Frequently used grid. */
export const ENTITY_CARD_CLASS =
  "flex min-w-0 items-center gap-3 rounded-xl border border-secondary bg-primary p-3 outline-focus-ring transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2";

/**
 * An entity as a link to where it opens: a channel itself; the viewer's own Agent its direct
 * messages (the Web opens an Agent's DM only for its owner), any other Agent its profile; a
 * Computer its page. Each branch is its own `Link`, so the router checks every destination.
 * `onOpen` runs as it opens.
 */
export function SearchEntityRow({
  entity,
  display,
  className,
  onOpen,
}: {
  entity: SearchEntity;
  display: AgentDisplaySnapshot | undefined;
  className: string;
  onOpen?: () => void;
}) {
  const props = {
    className,
    onClick: onOpen,
    "data-search-entity": `${entity.kind}:${entity.id}`,
    children: <EntityContent entity={entity} display={display} />,
  };
  switch (entity.kind) {
    case "channel":
      return <Link {...conversationRoute({ channelId: entity.id })} {...props} />;
    case "computer":
      return <Link to="/computers/$computerId" params={{ computerId: entity.id }} {...props} />;
    case "agent":
      return entity.ownedByCurrentUser ? (
        <Link {...conversationRoute({ agentId: entity.id })} {...props} />
      ) : (
        <Link to="/agents" search={{ profile: formatAgentProfileParam(entity.id) }} {...props} />
      );
  }
}

function EntityContent({
  entity,
  display,
}: {
  entity: SearchEntity;
  display: AgentDisplaySnapshot | undefined;
}) {
  return (
    <>
      <EntityMark entity={entity} display={display} />
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
      <span className="min-w-0 truncate text-xs text-tertiary">{entitySubtitle(entity)}</span>
    </>
  );
}

const KIND_LABEL: Record<SearchEntity["kind"], () => string> = {
  channel: () => m.search_entity_channel(),
  computer: () => m.search_entity_computer(),
  agent: () => m.search_entity_agent(),
};

/** The channels, Computers and Agents a query names, listed above the messages. */
export function SearchEntityList({
  entities,
  onOpen,
}: {
  entities: readonly SearchEntity[];
  onOpen: (entity: SearchEntity) => void;
}) {
  const displays = useAgentDisplays();
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
            <SearchEntityRow
              entity={entity}
              display={displays.get(entity.id)}
              className={ENTITY_ROW_CLASS}
              onOpen={() => onOpen(entity)}
            />
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
    // The row's own text names the Agent, so the avatar is hidden from screen readers; its live
    // status, which the dot shows, is read out on its own.
    return (
      <>
        <span aria-hidden="true" className="shrink-0">
          <AgentDisplayAvatar
            name={entity.name}
            src={entity.avatarUrl}
            display={display}
            size="xs"
          />
        </span>
        <span className="sr-only">{agentDisplay(display).label}</span>
      </>
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
