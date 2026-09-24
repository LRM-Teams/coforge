import { TASK_STATUSES, type TaskStatus } from "@lrm/coforge-sdk/internal";
import { useMemo } from "react";
import { FilterLines, Sliders04, XClose } from "@untitledui/icons";
import {
  Dialog as AriaDialog,
  DialogTrigger,
  SubmenuTrigger,
  ToggleButton,
} from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import {
  TASK_DISPLAY_FIELDS,
  useTaskDisplayFields,
  type TaskDisplayField,
} from "./task-display-fields";
import {
  ownerOptions,
  projectOptions,
  type FilterableTask,
  type OwnerOption,
  type TaskFilter,
} from "./task-filters";
import { TaskLayoutToggle, statusLabel, type TaskLayout } from "./task-workflow";

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
}: {
  tasks: readonly FilterableTask[];
  filter: TaskFilter;
  status?: TaskStatus;
  layout: TaskLayout;
  onFilterChange: (filter: TaskFilter) => void;
  onStatusChange: (status?: TaskStatus) => void;
  onLayoutChange: (layout: TaskLayout) => void;
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
  const labelsOf = (options: readonly Choice[], picked: readonly string[]) =>
    picked.map((id) => options.find((option) => option.id === id)?.label ?? id);

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
        {filter.owners.length > 0 && (
          <FilterChip
            label={m.tasks_filter_owner_is({ names: namesLabel(labelsOf(owners, filter.owners)) })}
            onRemove={() => onFilterChange({ ...filter, owners: [] })}
          />
        )}
        {filter.projects.length > 0 && (
          <FilterChip
            label={m.tasks_filter_project_is({
              names: namesLabel(labelsOf(projects, filter.projects)),
            })}
            onRemove={() => onFilterChange({ ...filter, projects: [] })}
          />
        )}
        {status && (
          <FilterChip
            label={m.tasks_filter_status_is({ name: statusLabel(status) })}
            onRemove={() => onStatusChange(undefined)}
          />
        )}
      </div>
      <DisplayMenu layout={layout} onLayoutChange={onLayoutChange} />
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

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-7 max-w-[20rem] items-center gap-1 rounded-md border border-secondary pr-0.5 pl-2.5 text-xs text-secondary">
      <span className="truncate">{label}</span>
      <ButtonUtility
        size="xs"
        color="tertiary"
        icon={XClose}
        aria-label={m.tasks_filter_remove({ filter: label })}
        onClick={onRemove}
      />
    </span>
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
}: {
  layout: TaskLayout;
  onLayoutChange: (layout: TaskLayout) => void;
}) {
  const [fields, setField] = useTaskDisplayFields();
  return (
    <DialogTrigger>
      <Button size="sm" color="secondary" iconLeading={Sliders04}>
        {m.tasks_display()}
      </Button>
      <Dropdown.Popover placement="bottom end" className="w-72">
        <AriaDialog
          aria-label={m.tasks_display()}
          className="flex flex-col gap-4 p-3 outline-hidden"
        >
          <TaskLayoutToggle layout={layout} onChange={onLayoutChange} />
          <div className="flex flex-col gap-2 border-t border-secondary pt-3">
            <p className="text-xs font-medium text-tertiary">{m.tasks_display_fields()}</p>
            <div className="flex flex-wrap gap-1.5">
              {TASK_DISPLAY_FIELDS.map((field) => (
                <ToggleButton
                  key={field}
                  isSelected={fields[field]}
                  onChange={(shown) => setField(field, shown)}
                  className={({ isSelected, isFocusVisible }) =>
                    cn(
                      "h-7 cursor-pointer rounded-md border px-2.5 text-xs font-medium outline-focus-ring",
                      isFocusVisible && "outline-2",
                      isSelected
                        ? "border-primary bg-secondary text-secondary"
                        : "border-secondary bg-primary text-quaternary",
                    )
                  }
                >
                  {FIELD_LABEL[field]()}
                </ToggleButton>
              ))}
            </div>
          </div>
        </AriaDialog>
      </Dropdown.Popover>
    </DialogTrigger>
  );
}
