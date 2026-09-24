import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { SearchLg, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#src/components/ui/empty";
import { useAgentDisplays } from "#src/features/agents/workspace-agents-realtime";
import { m } from "#src/paraglide/messages";
import type { SearchEntity } from "./search-entities";
import { ENTITY_CARD_CLASS, SearchEntityRow } from "./search-entity-list";
import { frequentEntities, type RememberedEntity, type SearchUsage } from "./search-memory";
import { searchDirectoryQuery } from "./search-queries";

/**
 * The search page with nothing typed and no filter: the viewer's recent searches and the places
 * they open most from search, or a prompt when there are neither yet.
 */
export function SearchHome({
  workspaceId,
  loaded,
  history,
  usage,
  onSearch,
  onRemoveSearch,
  onClearHistory,
  onOpen,
}: {
  workspaceId: string;
  /** False until this browser's memory has been read after mount. */
  loaded: boolean;
  history: readonly string[];
  usage: SearchUsage;
  onSearch: (query: string) => void;
  onRemoveSearch: (query: string) => void;
  onClearHistory: () => void;
  onOpen: (entity: SearchEntity) => void;
}) {
  const frequent = useFrequentEntities(workspaceId, usage);
  const displays = useAgentDisplays();

  // Still reading: not yet "nothing remembered", so no empty state.
  if (!loaded || frequent.pending) return null;

  if (history.length === 0 && frequent.entities.length === 0 && !frequent.failed) {
    return (
      <div className="flex min-h-0 flex-1 items-start justify-center px-6 pt-16">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchLg aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{m.search_empty_title()}</EmptyTitle>
            <EmptyDescription>{m.search_empty_description()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4 sm:px-6">
      {history.length > 0 && (
        <section aria-labelledby="search-history-heading" className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h2 id="search-history-heading" className="text-sm font-semibold text-secondary">
              {m.search_history_heading()}
            </h2>
            <Button size="sm" color="link-gray" onClick={onClearHistory}>
              {m.search_history_clear()}
            </Button>
          </div>
          <ul className="flex flex-wrap gap-2">
            {history.map((query) => (
              <li key={query} className="flex items-center gap-0.5">
                <Button
                  size="sm"
                  color="secondary"
                  data-search-history={query}
                  className="max-w-[16rem]"
                  onClick={() => onSearch(query)}
                >
                  <span className="truncate">{query}</span>
                </Button>
                <ButtonUtility
                  icon={XClose}
                  size="xs"
                  color="tertiary"
                  tooltip={m.search_history_remove({ query })}
                  aria-label={m.search_history_remove({ query })}
                  onClick={() => onRemoveSearch(query)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="search-frequent-heading" className="flex flex-col gap-2">
        <h2 id="search-frequent-heading" className="text-sm font-semibold text-secondary">
          {m.search_frequent_heading()}
        </h2>
        {frequent.failed ? (
          <p role="alert" className="text-sm text-error-primary">
            {m.search_frequent_failed()}
          </p>
        ) : frequent.entities.length > 0 ? (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {frequent.entities.map((entity) => (
              <li key={`${entity.kind}:${entity.id}`}>
                <SearchEntityRow
                  entity={entity}
                  display={displays.get(entity.id)}
                  className={ENTITY_CARD_CLASS}
                  onOpen={() => onOpen(entity)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-secondary p-4 text-sm text-tertiary">
            {m.search_frequent_empty()}
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * The remembered places, ranked, as the Workspace lists name them now. A place that is gone, or a
 * channel that has been archived, is left out.
 */
function useFrequentEntities(
  workspaceId: string,
  usage: SearchUsage,
): { entities: SearchEntity[]; pending: boolean; failed: boolean } {
  const { data: directory, isPending, isError } = useQuery(searchDirectoryQuery(workspaceId));
  const entities = useMemo(() => {
    if (!directory) return [];
    const channels = new Map(
      directory.channels
        .filter((channel) => !channel.archived)
        .map((channel) => [channel.id, channel]),
    );
    const agents = new Map(directory.agents.map((agent) => [agent.id, agent]));
    const usable = ({ kind, id }: RememberedEntity) =>
      kind === "channel" ? channels.has(id) : agents.has(id);
    return frequentEntities(usage, Date.now(), usable).map(({ kind, id }): SearchEntity =>
      kind === "channel"
        ? { kind: "channel", ...channels.get(id)! }
        : { kind: "agent", ...agents.get(id)! },
    );
  }, [directory, usage]);
  // With nothing remembered there is nothing to wait for.
  const remembered = Object.keys(usage).length > 0;
  return { entities, pending: remembered && isPending, failed: remembered && isError };
}
