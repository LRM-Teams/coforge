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
import { frequentEntities, type SearchUsage } from "./search-memory";
import { searchDirectoryQuery } from "./search-queries";

/**
 * The search page with nothing typed and no filter: the viewer's recent searches and the places
 * they open most from search, or a prompt when there are neither yet.
 */
export function SearchHome({
  workspaceId,
  history,
  usage,
  onSearch,
  onRemoveSearch,
  onClearHistory,
  onOpen,
}: {
  workspaceId: string;
  history: readonly string[];
  usage: SearchUsage;
  onSearch: (query: string) => void;
  onRemoveSearch: (query: string) => void;
  onClearHistory: () => void;
  onOpen: (entity: SearchEntity) => void;
}) {
  const frequent = useFrequentEntities(workspaceId, usage);
  const displays = useAgentDisplays();

  if (history.length === 0 && frequent.length === 0) {
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
        {frequent.length > 0 ? (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {frequent.map((entity) => (
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
function useFrequentEntities(workspaceId: string, usage: SearchUsage): SearchEntity[] {
  const directory = useQuery(searchDirectoryQuery(workspaceId)).data;
  return useMemo(() => {
    if (!directory) return [];
    const channels = new Map(directory.channels.map((channel) => [channel.id, channel]));
    const agents = new Map(directory.agents.map((agent) => [agent.id, agent]));
    return frequentEntities(usage, Date.now()).flatMap(({ kind, id }): SearchEntity[] => {
      if (kind === "channel") {
        const channel = channels.get(id);
        return channel && !channel.archived ? [{ kind: "channel", ...channel }] : [];
      }
      const agent = agents.get(id);
      return agent ? [{ kind: "agent", ...agent }] : [];
    });
  }, [directory, usage]);
}
