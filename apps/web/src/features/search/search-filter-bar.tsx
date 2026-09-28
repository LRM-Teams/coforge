import { useMemo, useState, type FC, type Key, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, SearchLg } from "@untitledui/icons";
import {
  Autocomplete as AriaAutocomplete,
  Input as AriaInput,
  SearchField as AriaSearchField,
  useFilter,
} from "react-aria-components";

import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { m } from "#src/paraglide/messages";
import {
  clearedFilters,
  hasActiveFilter,
  isSearchRange,
  SEARCH_RANGES,
  SEARCH_SCOPES,
  withScope,
  withSender,
  type SearchFilters,
  type SearchRange,
  type SearchScope,
  type SenderKind,
} from "./search-filters";
import { searchDirectoryQuery } from "./search-queries";

const ANY = "any";

const RANGE_LABEL: Record<SearchRange, () => string> = {
  today: () => m.search_time_today(),
  "7d": () => m.search_time_last_7_days(),
  "30d": () => m.search_time_last_30_days(),
};

const SCOPE_LABEL: Record<SearchScope, () => string> = {
  mentioned: () => m.search_scope_mentioned(),
  humans: () => m.search_scope_humans(),
  agents: () => m.search_scope_agents(),
};

/** Menu rows keep their width; a very long username (a generated one) is cut with an ellipsis. */
function shortHandle(handle: string) {
  return handle.length > 24 ? `${handle.slice(0, 23)}…` : handle;
}

type Sender = {
  key: string;
  id: string;
  kind: SenderKind;
  /** The row label: the display name, or "Me" for the viewer. */
  label: string;
  name: string;
  handle: string;
  avatarUrl?: string | null;
};

/**
 * A menu row's leading avatar: the photo, or the name's initial on its own colour, as avatars
 * show everywhere else. Passed as the row's `icon`, so the selection check sits at the end.
 */
function senderAvatar(sender: Sender): FC<{ className?: string }> {
  return function SenderAvatar() {
    // The row's own label names the sender; the initial is decoration, so screen readers skip
    // it (the official Avatar does not forward `aria-hidden`). Sized like the menu's own avatars.
    return (
      <span aria-hidden="true" className="mr-2 shrink-0">
        <Avatar
          size="xs"
          alt=""
          src={sender.avatarUrl ?? undefined}
          initials={avatarInitial(sender.name)}
          contentClassName={avatarToneClassName(sender.name)}
          className="size-5"
        />
      </span>
    );
  };
}

/**
 * The filters under the search box: From, Scope, Channel, Time and Sort, then Clear all. Each
 * chip names its current value. Sort applies only to a query, so it is disabled without one.
 */
export function SearchFilterBar({
  workspaceId,
  query,
  filters,
  onChange,
}: {
  workspaceId: string;
  query: string;
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
}) {
  const directory = useQuery(searchDirectoryQuery(workspaceId)).data;
  const senders = useMemo<Sender[]>(() => {
    if (!directory) return [];
    const people = [
      // The viewer first, as "Me".
      ...directory.people.filter((person) => person.id === directory.viewerId),
      ...directory.people.filter((person) => person.id !== directory.viewerId),
    ].map((person): Sender => ({
      ...person,
      key: `user:${person.id}`,
      kind: "user",
      label: person.id === directory.viewerId ? m.search_from_me() : person.name,
    }));
    const agents = directory.agents.map((agent): Sender => ({
      ...agent,
      key: `agent:${agent.id}`,
      kind: "agent",
      label: agent.name,
    }));
    return [...people, ...agents];
  }, [directory]);
  // One avatar component per sender, kept across renders so menu rows do not remount.
  const avatars = useMemo(
    () => new Map(senders.map((candidate) => [candidate.key, senderAvatar(candidate)])),
    [senders],
  );
  const sender = senders.find((candidate) => candidate.id === filters.senderId);
  const channel = directory?.channels.find((candidate) => candidate.id === filters.channelId);
  const scopeCount = filters.scope?.length ?? 0;

  return (
    <div role="group" aria-label={m.search_filters()} className="flex flex-wrap items-center gap-2">
      <SearchableChip
        label={sender ? m.search_from_named({ name: sender.label }) : m.search_from()}
        searchLabel={m.search_find_sender()}
        selectedKey={sender?.key ?? ANY}
        anyLabel={m.search_from_anyone()}
        items={senders.map((candidate) => ({
          key: candidate.key,
          label: candidate.label,
          textValue: `${candidate.label} ${candidate.name} ${candidate.handle}`,
          addon: `@${shortHandle(candidate.handle)}`,
          icon: avatars.get(candidate.key),
        }))}
        onSelect={(key) => {
          const chosen = senders.find((candidate) => candidate.key === key);
          onChange(withSender(filters, chosen && { id: chosen.id, kind: chosen.kind }));
        }}
      />
      <Dropdown.Root>
        <Chip>{scopeCount ? m.search_scope_count({ count: scopeCount }) : m.search_scope()}</Chip>
        <Dropdown.Popover placement="bottom start" className="w-56">
          <Dropdown.Menu
            aria-label={m.search_scope()}
            selectionMode="multiple"
            selectedKeys={filters.scope ?? []}
            shouldCloseOnSelect={false}
            onSelectionChange={(keys) => {
              if (keys === "all") return;
              onChange(withScope(filters, keys, sender?.kind));
            }}
          >
            {SEARCH_SCOPES.map((scope) => (
              <Dropdown.Item
                key={scope}
                id={scope}
                label={SCOPE_LABEL[scope]()}
                selectionIndicator="checkbox"
              />
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      <SearchableChip
        label={channel ? `#${channel.name}` : m.search_channel()}
        searchLabel={m.search_find_channel()}
        selectedKey={filters.channelId ?? ANY}
        anyLabel={m.search_channel_any()}
        items={(directory?.channels ?? []).map((candidate) => ({
          key: candidate.id,
          label: `#${candidate.name}`,
          textValue: `${candidate.name} ${candidate.description}`,
          addon: candidate.archived ? m.search_archived() : undefined,
        }))}
        onSelect={(key) => onChange({ ...filters, channelId: key })}
      />
      <SingleChoiceChip
        ariaLabel={m.search_time()}
        label={filters.range ? RANGE_LABEL[filters.range]() : m.search_time()}
        selectedKey={filters.range ?? ANY}
        options={[
          { key: ANY, label: m.search_time_any() },
          ...SEARCH_RANGES.map((range) => ({ key: range, label: RANGE_LABEL[range]() })),
        ]}
        onSelect={(key) => onChange({ ...filters, range: isSearchRange(key) ? key : undefined })}
      />
      <SingleChoiceChip
        ariaLabel={m.search_sort()}
        label={m.search_sort_named({
          order: filters.sort === "recent" ? m.search_sort_recent() : m.search_sort_relevant(),
        })}
        disabled={!query}
        selectedKey={filters.sort ?? "relevance"}
        options={[
          { key: "relevance", label: m.search_sort_relevant() },
          { key: "recent", label: m.search_sort_recent() },
        ]}
        onSelect={(key) => onChange({ ...filters, sort: key === "recent" ? "recent" : undefined })}
      />
      {hasActiveFilter(filters) && (
        <Button size="sm" color="link-gray" onClick={() => onChange(clearedFilters(filters))}>
          {m.search_clear_filters()}
        </Button>
      )}
    </div>
  );
}

/**
 * A filter chip: the trigger button of its menu. A toolbar button stays secondary (design §11),
 * so the label, which names the chosen value, is what shows a filter is set.
 */
function Chip({ disabled, children }: { disabled?: boolean; children: ReactNode }) {
  return (
    <Button
      size="sm"
      color="secondary"
      iconTrailing={ChevronDown}
      isDisabled={disabled}
      className="max-w-[16rem]"
    >
      {children}
    </Button>
  );
}

function SingleChoiceChip({
  ariaLabel,
  label,
  disabled,
  selectedKey,
  options,
  onSelect,
}: {
  ariaLabel: string;
  label: string;
  disabled?: boolean;
  selectedKey: string;
  options: { key: string; label: string }[];
  onSelect: (key: string) => void;
}) {
  return (
    <Dropdown.Root>
      <Chip disabled={disabled}>{label}</Chip>
      <Dropdown.Popover placement="bottom start" className="w-48">
        <Dropdown.Menu
          aria-label={ariaLabel}
          selectionMode="single"
          selectedKeys={[selectedKey]}
          onAction={(key) => onSelect(String(key))}
        >
          {options.map((option) => (
            <Dropdown.Item key={option.key} id={option.key} label={option.label} />
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}

/**
 * A chip whose menu is a searchable list with an "any" entry first that clears the filter, the
 * same shape as the Task assignee picker.
 */
function SearchableChip({
  label,
  searchLabel,
  selectedKey,
  anyLabel,
  items,
  onSelect,
}: {
  label: string;
  searchLabel: string;
  selectedKey: string;
  anyLabel: string;
  items: {
    key: string;
    label: string;
    textValue: string;
    addon?: string;
    icon?: FC<{ className?: string }>;
  }[];
  onSelect: (key: string | undefined) => void;
}) {
  const { contains } = useFilter({ sensitivity: "base" });
  const [search, setSearch] = useState("");
  return (
    <Dropdown.Root onOpenChange={(isOpen) => isOpen && setSearch("")}>
      <Chip>{label}</Chip>
      <Dropdown.Popover placement="bottom start" className="w-72">
        <AriaAutocomplete filter={contains} inputValue={search} onInputChange={setSearch}>
          <div className="border-b border-secondary py-1">
            <AriaSearchField aria-label={searchLabel} value={search} onChange={setSearch} autoFocus>
              <div className="flex items-center gap-2 px-3 py-2">
                <SearchLg aria-hidden="true" className="size-4 shrink-0 text-fg-quaternary" />
                <AriaInput
                  placeholder={searchLabel}
                  className="w-full bg-transparent text-sm text-primary outline-hidden placeholder:text-placeholder"
                />
              </div>
            </AriaSearchField>
          </div>
          <Dropdown.Menu
            aria-label={searchLabel}
            selectionMode="single"
            selectedKeys={[selectedKey]}
            className="max-h-72"
            onAction={(key: Key) => onSelect(key === ANY ? undefined : String(key))}
          >
            <Dropdown.Item id={ANY} label={anyLabel} />
            {items.map((item) => (
              <Dropdown.Item
                key={item.key}
                id={item.key}
                label={item.label}
                textValue={item.textValue}
                addon={item.addon}
                icon={item.icon}
              />
            ))}
          </Dropdown.Menu>
        </AriaAutocomplete>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
