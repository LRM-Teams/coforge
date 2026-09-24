import { TASK_STATUSES, type TaskStatus } from "@lrm/coforge-sdk/internal";
import { useMemo } from "react";
import { Columns03, FilterLines, List, Sliders04 } from "@untitledui/icons";
import {
  Dialog as AriaDialog,
  DialogTrigger,
  Radio,
  RadioGroup,
  SubmenuTrigger,
  Tag,
  TagGroup,
  TagList,
} from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { Toggle } from "#src/components/base/toggle/toggle";
import { cn } from "#src/lib/utils";
import { TagCloseX } from "#src/components/base/tags/base-components/tag-close-x";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Select } from "#src/components/base/select/select";
import { m } from "#src/paraglide/messages";
import {
  TASK_DISPLAY_FIELDS,
  useTaskDisplayFields,
  type TaskDisplayField,
} from "#src/features/settings/task-display-fields";
import {
  NO_OWNER,
  NO_PROJECT,
  ownerOptions,
  projectOptions,
  type FilterableTask,
  type OwnerOption,
  type TaskFilter,
} from "./task-filters";
import { statusLabel, type TaskLayout } from "./task-workflow";
import type { FinishedWindow } from "./finished-tasks";

const ALL_STATUSES = "all";

/**
 * The Tasks page's toolbar: "Filter" (owner, Project and status, each a submenu of choices with
 * how many Tasks each has) followed by one removable chip per filter in use, and "Display" on
 * the right (board or list, and which parts of a Task show).
 */
export function TaskToolbar({
  tasks,
  filter,
  status,
  layout,
  onFilterChange,
  onStatusChange,
  onLayoutChange,
  completedWindow,
  onWindowChange,
}: {
  tasks: readonly FilterableTask[];
  filter: TaskFilter;
  status?: TaskStatus;
  layout: TaskLayout;
  onFilterChange: (filter: TaskFilter) => void;
  onStatusChange: (status?: TaskStatus) => void;
  onLayoutChange: (layout: TaskLayout) => void;
  /** How far back Done and Closed reach; Display offers it, as Linear's completed issues do. */
  completedWindow: FinishedWindow;
  onWindowChange: (completedWindow: FinishedWindow) => void;
}) {
  // Counted over every Task, so the numbers hold still while picking.
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
  // A pick no listed Task has (a saved link, an older finished Task's owner) has no name here.
  const labelsOf = (options: readonly Choice[], picked: readonly string[], none: string) =>
    picked.map(
      (id) =>
        options.find((option) => option.id === id)?.label ??
        (id === NO_OWNER || id === NO_PROJECT ? none : m.tasks_filter_other()),
    );
  const chips = [
    filter.owners.length > 0 && {
      id: "owners",
      label: m.tasks_filter_owner_is({
        names: namesLabel(labelsOf(owners, filter.owners, m.tasks_unassigned())),
      }),
      remove: () => onFilterChange({ ...filter, owners: [] }),
    },
    filter.projects.length > 0 && {
      id: "projects",
      label: m.tasks_filter_project_is({
        names: namesLabel(labelsOf(projects, filter.projects, m.tasks_overview_no_project())),
      }),
      remove: () => onFilterChange({ ...filter, projects: [] }),
    },
    status && {
      id: "status",
      label: m.tasks_filter_status_is({ name: statusLabel(status) }),
      remove: () => onStatusChange(undefined),
    },
  ].filter((chip) => chip !== false && chip !== undefined);

  return (
    <div className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-b border-secondary px-4 py-1.5 md:px-6">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Dropdown.Root>
          <Button size="sm" color="tertiary" iconLeading={FilterLines}>
            {m.tasks_filter()}
          </Button>
          <Dropdown.Popover placement="bottom start" className="w-52">
            <Dropdown.Menu aria-label={m.tasks_filter()}>
              <FilterSubmenu
                name={m.tasks_overview_owner()}
                options={owners}
                picked={filter.owners}
                onChange={(picked) => onFilterChange({ ...filter, owners: picked })}
              />
              <FilterSubmenu
                name={m.tasks_overview_project()}
                options={projects}
                picked={filter.projects}
                onChange={(picked) => onFilterChange({ ...filter, projects: picked })}
              />
              <SubmenuTrigger>
                <Dropdown.Item label={m.tasks_overview_status()} />
                <Dropdown.Popover placement="end top" className="w-52">
                  <Dropdown.Menu
                    aria-label={m.tasks_overview_status()}
                    selectionMode="single"
                    selectedKeys={[status ?? ALL_STATUSES]}
                    onAction={(key) => onStatusChange(TASK_STATUSES.find((value) => value === key))}
                  >
                    <Dropdown.Item id={ALL_STATUSES} label={m.tasks_overview_all()} />
                    {TASK_STATUSES.map((value) => (
                      <Dropdown.Item key={value} id={value} label={statusLabel(value)} />
                    ))}
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </SubmenuTrigger>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown.Root>
        {
          // Removing one moves focus to its neighbour, or to the group once none is left, so the
          // group stays mounted (React Aria TagGroup).
          <TagGroup
            aria-label={m.tasks_filters_in_use()}
            onRemove={(keys) => {
              for (const chip of chips) if (keys.has(chip.id)) chip.remove();
            }}
          >
            <TagList className="flex flex-wrap items-center gap-2">
              {chips.map((chip) => (
                <Tag
                  key={chip.id}
                  id={chip.id}
                  textValue={chip.label}
                  className="inline-flex h-7 max-w-[20rem] cursor-default items-center gap-1 rounded-md border border-secondary pr-1.5 pl-2.5 text-xs text-secondary outline-focus-ring focus-visible:outline-2"
                >
                  <span className="truncate">{chip.label}</span>
                  {/* React Aria names it "<this label> <the chip>". */}
                  <TagCloseX size="md" aria-label={m.tasks_filter_remove()} />
                </Tag>
              ))}
            </TagList>
          </TagGroup>
        }
      </div>
      <DisplayMenu
        layout={layout}
        onLayoutChange={onLayoutChange}
        completedWindow={completedWindow}
        onWindowChange={onWindowChange}
      />
    </div>
  );
}

function ownerLabel(option: OwnerOption) {
  if (option.kind === "me") return m.tasks_overview_me();
  if (option.kind === "none") return m.tasks_unassigned();
  return option.name;
}

/** Up to two names, then how many more. */
function namesLabel(names: readonly string[]) {
  return names.length <= 2
    ? names.join(", ")
    : m.tasks_filter_names_more({ names: names.slice(0, 2).join(", "), count: names.length - 2 });
}

type Choice = { id: string; label: string; count: number };

function FilterSubmenu({
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
  return (
    <SubmenuTrigger>
      <Dropdown.Item label={name} />
      <Dropdown.Popover placement="end top" className="w-64">
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
    </SubmenuTrigger>
  );
}

const FIELD_LABEL: Record<TaskDisplayField, () => string> = {
  number: () => m.tasks_field_number(),
  source: () => m.tasks_field_source(),
  project: () => m.tasks_overview_project(),
  owner: () => m.tasks_overview_owner(),
};

function DisplayMenu({
  layout,
  onLayoutChange,
  completedWindow,
  onWindowChange,
}: {
  layout: TaskLayout;
  onLayoutChange: (layout: TaskLayout) => void;
  completedWindow: FinishedWindow;
  onWindowChange: (completedWindow: FinishedWindow) => void;
}) {
  const [fields, setFields] = useTaskDisplayFields();
  return (
    <DialogTrigger>
      <Button size="sm" color="secondary" iconLeading={Sliders04}>
        {m.tasks_display()}
      </Button>
      <Dropdown.Popover placement="bottom end" className="w-72">
        <AriaDialog
          aria-label={m.tasks_display()}
          className="flex flex-col gap-3 p-3 outline-hidden"
        >
          {/* Board or list as two tiles, the chosen one filled, as Linear's Display does. */}
          <RadioGroup
            aria-label={m.tasks_layout()}
            value={layout}
            onChange={(value) => {
              if (value === "board" || value === "list") onLayoutChange(value);
            }}
            className="grid grid-cols-2 gap-2"
          >
            {(
              [
                ["board", Columns03, m.tasks_layout_board()],
                ["list", List, m.tasks_layout_list()],
              ] as const
            ).map(([value, Icon, label]) => (
              <Radio
                key={value}
                value={value}
                className={({ isSelected, isFocusVisible, isHovered }) =>
                  cn(
                    "flex h-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border text-sm font-medium outline-focus-ring transition-colors",
                    isSelected
                      ? "border-brand bg-brand-primary text-brand-secondary"
                      : cn("border-secondary text-tertiary", isHovered && "bg-primary_hover"),
                    isFocusVisible && "outline-2 outline-offset-2",
                  )
                }
              >
                <Icon aria-hidden="true" className="size-5" />
                {label}
              </Radio>
            ))}
          </RadioGroup>
          <div className="flex items-center justify-between gap-3 border-t border-secondary pt-3">
            <span className="text-sm text-secondary">{m.tasks_finished_window()}</span>
            <Select
              aria-label={m.tasks_finished_window()}
              size="sm"
              className="w-32"
              selectedKey={completedWindow}
              onSelectionChange={(key) => {
                if (key === "week" || key === "month" || key === "all") onWindowChange(key);
              }}
            >
              <Select.Item id="week" label={m.tasks_finished_week()} />
              <Select.Item id="month" label={m.tasks_finished_month()} />
              <Select.Item id="all" label={m.tasks_finished_all()} />
            </Select>
          </div>
          {/* One switch per field: on or off at a glance. */}
          <div className="flex flex-col gap-2.5 border-t border-secondary pt-3">
            <p className="text-xs font-medium text-tertiary">{m.tasks_display_fields()}</p>
            {TASK_DISPLAY_FIELDS.map((field) => (
              <Toggle
                key={field}
                size="sm"
                label={FIELD_LABEL[field]()}
                isSelected={fields[field]}
                onChange={(shown) => setFields({ ...fields, [field]: shown })}
              />
            ))}
          </div>
        </AriaDialog>
      </Dropdown.Popover>
    </DialogTrigger>
  );
}
