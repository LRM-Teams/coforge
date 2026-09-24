import { useMemo } from "react";
import { ChevronDown } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { m } from "#src/paraglide/messages";
import {
  ownerOptions,
  projectOptions,
  type FilterableTask,
  type OwnerOption,
  type TaskFilter,
} from "./task-filters";

/**
 * The Tasks page's Owner and Project filters, then Clear filters. Each is a menu of choices with
 * how many Tasks each has, counted over every Task so the numbers hold still while picking.
 */
export function TaskFilterMenus({
  tasks,
  filter,
  onChange,
}: {
  tasks: readonly FilterableTask[];
  filter: TaskFilter;
  onChange: (filter: TaskFilter) => void;
}) {
  const owners = useMemo(
    () =>
      ownerOptions(tasks).map((option) => ({
        id: option.id,
        label: ownerLabel(option),
        count: option.count,
      })),
    [tasks],
  );
  const projects = useMemo(
    () =>
      projectOptions(tasks).map((option) => ({
        id: option.id,
        label: option.name || m.tasks_overview_no_project(),
        count: option.count,
      })),
    [tasks],
  );
  return (
    <>
      <FilterMenu
        name={m.tasks_overview_owner()}
        options={owners}
        picked={filter.owners}
        onChange={(picked) => onChange({ ...filter, owners: picked })}
      />
      <FilterMenu
        name={m.tasks_overview_project()}
        options={projects}
        picked={filter.projects}
        onChange={(picked) => onChange({ ...filter, projects: picked })}
      />
      {(filter.owners.length > 0 || filter.projects.length > 0) && (
        <Button size="sm" color="link-gray" onClick={() => onChange({ owners: [], projects: [] })}>
          {m.tasks_overview_clear_filters()}
        </Button>
      )}
    </>
  );
}

function ownerLabel(option: OwnerOption) {
  if (option.kind === "me") return m.tasks_overview_me();
  if (option.kind === "none") return m.tasks_unassigned();
  return option.name;
}

type Choice = { id: string; label: string; count: number };

/** A menu of several picks behind a chip that names them: the filter's name, the one pick, or
 * the filter's name and how many are picked. */
function FilterMenu({
  name,
  options,
  picked,
  onChange,
}: {
  name: string;
  options: readonly Choice[];
  picked: readonly string[];
  onChange: (picked: string[]) => void;
}) {
  const label =
    picked.length === 0
      ? name
      : picked.length === 1
        ? (options.find((option) => option.id === picked[0])?.label ?? name)
        : m.tasks_overview_filter_count({ label: name, count: picked.length });
  return (
    <Dropdown.Root>
      <Button
        size="sm"
        color={picked.length > 0 ? "primary" : "secondary"}
        iconTrailing={ChevronDown}
        className="max-w-[14rem]"
      >
        {label}
      </Button>
      <Dropdown.Popover placement="bottom start" className="w-64">
        <Dropdown.Menu
          aria-label={name}
          selectionMode="multiple"
          selectedKeys={picked}
          shouldCloseOnSelect={false}
          className="max-h-80"
          onSelectionChange={(keys) => {
            if (keys !== "all") onChange([...keys].map(String));
          }}
        >
          {options.map((option) => (
            <Dropdown.Item
              key={option.id}
              id={option.id}
              label={option.label}
              addon={String(option.count)}
              selectionIndicator="checkbox"
            />
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown.Root>
  );
}
