import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Edit01 as Edit, Settings01 as Settings } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import { formatAgentProfileParam } from "#src/features/agents/profile-panel/profile-panel-search";
import { m } from "#src/paraglide/messages";
import {
  collectPathLines,
  defaultCollectScanPath,
  removeCollectPathLine,
} from "./collect-scan-path";
import {
  defaultCustomRangeEndingToday,
  listCollectWindowOptions,
  type CollectWindowKind,
} from "./weekly-report-collect-window";
import {
  ensureWeeklyReportCollector,
  listWeeklyReportCollectorSlots,
  submitWeeklyReportCollectPlan,
} from "./records.functions";
import { RECORDS_PRIMARY_BUTTON_CLASSNAME } from "./records-primary-button";

/** Selected state uses the same neutral black fill as Records primary buttons. */
const COLLECT_PLAN_CHECKBOX_CLASSNAME =
  "[&[data-selected]>div]:bg-primary-solid! [&[data-selected]>div]:ring-primary-solid!";

type SlotRow = Awaited<ReturnType<typeof listWeeklyReportCollectorSlots>>[number];

const WINDOW_KINDS: CollectWindowKind[] = ["week", "month", "quarter", "year", "custom"];

export function WeeklyReportCollectPlanCard(props: {
  reportId: string;
  year: number;
  week: number;
  disabled?: boolean;
  onSubmitted?: (runId: string) => void;
}) {
  const listSlots = useServerFn(listWeeklyReportCollectorSlots);
  const ensure = useServerFn(ensureWeeklyReportCollector);
  const submit = useServerFn(submitWeeklyReportCollectPlan);
  const navigate = useNavigate();
  const [slots, setSlots] = useState<SlotRow[]>([]);
  const [windowKind, setWindowKind] = useState<CollectWindowKind>("week");
  const [optionId, setOptionId] = useState(`${props.year}-W${props.week}`);
  const customDefault = defaultCustomRangeEndingToday();
  const [customStart, setCustomStart] = useState(customDefault.startDate);
  const [customEnd, setCustomEnd] = useState(customDefault.endDate);
  const [selected, setSelected] = useState<string[]>([]);
  const [pathsByComputer, setPathsByComputer] = useState<Record<string, string[]>>({});
  const [pathFocus, setPathFocus] = useState<{ computerId: string; index: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listSlots().then((rows) => {
      if (cancelled) return;
      setSlots(rows);
      setSelected(rows.filter((row) => row.ready).map((row) => row.computerId));
      setPathsByComputer(
        Object.fromEntries(
          rows.map((row) => [
            row.computerId,
            collectPathLines(defaultCollectScanPath(row.platform)),
          ]),
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [listSlots]);

  const options = useMemo(() => listCollectWindowOptions(windowKind), [windowKind]);
  const selectedOption = options.find((row) => row.id === optionId) ?? options[0];

  useEffect(() => {
    if (windowKind === "week") {
      setOptionId(`${props.year}-W${props.week}`);
    } else if (options[0]) {
      setOptionId(options[0].id);
    }
  }, [windowKind, props.year, props.week, options]);

  async function onEnsure(computerId: string) {
    setBusy(true);
    setError(null);
    try {
      const binding = await ensure({ data: { computerId } });
      const rows = await listSlots();
      setSlots(rows);
      // New collectors start unconfigured; open Agent edit so the User can pick runtime.
      if (binding.collectorAgentId) {
        void navigate({
          to: "/agents",
          search: {
            profile: formatAgentProfileParam(binding.collectorAgentId),
            agentTab: "profile",
          },
        });
      }
    } catch {
      setError(m.records_collect_plan_ensure_failed());
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit() {
    if (busy || props.disabled) return;
    const computers = selected
      .map((computerId) => {
        const slot = slots.find((row) => row.computerId === computerId);
        if (!slot?.ready) return null;
        const scanPaths = (pathsByComputer[computerId] ?? [])
          .map((line) => line.trim())
          .filter(Boolean);
        return { computerId, scanPaths };
      })
      .filter((row): row is { computerId: string; scanPaths: string[] } => row !== null);
    if (computers.length === 0) {
      setError(m.records_collect_plan_no_computers());
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await submit({
        data: {
          reportId: props.reportId,
          windowKind,
          year: selectedOption?.year,
          week: selectedOption?.week,
          month: selectedOption?.month,
          quarter: selectedOption?.quarter,
          customStart: windowKind === "custom" ? customStart : undefined,
          customEnd: windowKind === "custom" ? customEnd : undefined,
          computers,
        },
      });
      props.onSubmitted?.(result.id);
    } catch {
      setError(m.records_collect_plan_submit_failed());
    } finally {
      setBusy(false);
    }
  }

  function updatePathLine(computerId: string, index: number, next: string) {
    setPathsByComputer((prev) => {
      const lines = [...(prev[computerId] ?? [""])];
      lines[index] = next;
      return { ...prev, [computerId]: lines };
    });
  }

  function addPathLine(computerId: string) {
    const nextIndex = (pathsByComputer[computerId] ?? [""]).length;
    setPathsByComputer((prev) => ({
      ...prev,
      [computerId]: [...(prev[computerId] ?? [""]), ""],
    }));
    setPathFocus({ computerId, index: nextIndex });
  }

  function removePathLine(computerId: string, index: number) {
    setPathsByComputer((prev) => ({
      ...prev,
      [computerId]: removeCollectPathLine(prev[computerId] ?? [""], index),
    }));
    setPathFocus({ computerId, index: Math.max(0, index - 1) });
  }

  return (
    <div className="rounded-xl border border-secondary bg-primary p-4">
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-4">
        <p className="pt-2 text-sm text-tertiary">{m.records_collect_plan_window()}</p>
        <div className="space-y-2">
          <Select
            aria-label={m.records_collect_plan_window()}
            size="sm"
            selectedKey={windowKind}
            onSelectionChange={(key) => {
              if (typeof key === "string") setWindowKind(key as CollectWindowKind);
            }}
            isDisabled={busy || props.disabled}
          >
            {WINDOW_KINDS.map((kind) => (
              <Select.Item
                key={kind}
                id={kind}
                label={
                  kind === "week"
                    ? m.records_collect_window_week()
                    : kind === "month"
                      ? m.records_collect_window_month()
                      : kind === "quarter"
                        ? m.records_collect_window_quarter()
                        : kind === "year"
                          ? m.records_collect_window_year()
                          : m.records_collect_window_custom()
                }
              />
            ))}
          </Select>
          {windowKind === "custom" ? (
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="date"
                size="sm"
                aria-label={m.records_collect_plan_start_date()}
                value={customStart}
                onChange={setCustomStart}
                isDisabled={busy || props.disabled}
              />
              <Input
                type="date"
                size="sm"
                aria-label={m.records_collect_plan_end_date()}
                value={customEnd}
                onChange={setCustomEnd}
                isDisabled={busy || props.disabled}
              />
            </div>
          ) : (
            <Select
              aria-label={m.records_collect_plan_range()}
              size="sm"
              selectedKey={selectedOption?.id}
              onSelectionChange={(key) => {
                if (typeof key === "string") setOptionId(key);
              }}
              isDisabled={busy || props.disabled}
            >
              {options.map((option) => (
                <Select.Item key={option.id} id={option.id} label={option.label} />
              ))}
            </Select>
          )}
        </div>

        <p className="pt-3 text-sm text-tertiary">{m.records_collect_plan_computers()}</p>
        <div className="space-y-2">
          {slots.length === 0 ? (
            <p className="text-sm text-tertiary">{m.records_collect_plan_no_owned()}</p>
          ) : (
            slots.map((slot) => {
              const checked = selected.includes(slot.computerId);
              const lines = pathsByComputer[slot.computerId] ?? [""];
              return (
                <div
                  key={slot.computerId}
                  className={`rounded-xl border border-secondary p-3 ${checked ? "bg-secondary" : "bg-primary"}`}
                >
                  <div className="flex items-center gap-2 pl-6">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
                      {slot.displayName}
                    </span>
                    {!slot.ready ? (
                      <Button
                        size="sm"
                        color="secondary"
                        isDisabled={busy}
                        onPress={() => void onEnsure(slot.computerId)}
                      >
                        {m.records_collect_plan_setup()}
                      </Button>
                    ) : null}
                    {slot.collectorAgentId ? (
                      <Link
                        to="/agents"
                        search={{
                          profile: formatAgentProfileParam(slot.collectorAgentId),
                          agentTab: "profile",
                        }}
                        aria-label={m.records_collect_plan_gear()}
                        className="text-tertiary hover:text-primary"
                      >
                        <Settings className="size-4" />
                      </Link>
                    ) : null}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <Checkbox
                      className={`${COLLECT_PLAN_CHECKBOX_CLASSNAME} self-center`}
                      isSelected={checked}
                      isDisabled={busy || props.disabled || !slot.ready}
                      onChange={(next) => {
                        setSelected((prev) =>
                          next
                            ? [...new Set([...prev, slot.computerId])]
                            : prev.filter((id) => id !== slot.computerId),
                        );
                      }}
                    />
                    <div className="min-w-0 flex-1 rounded-lg border border-secondary bg-primary px-3 py-1.5">
                      {lines.map((line, index) => (
                        <CollectPathRow
                          key={`${slot.computerId}-${index}`}
                          value={line}
                          disabled={busy || props.disabled}
                          canRemove={lines.length > 1}
                          autoFocus={
                            pathFocus?.computerId === slot.computerId && pathFocus.index === index
                          }
                          onChange={(next) => updatePathLine(slot.computerId, index, next)}
                          onAdd={() => addPathLine(slot.computerId)}
                          onRemove={() => removePathLine(slot.computerId, index)}
                          onFocused={() => setPathFocus(null)}
                        />
                      ))}
                    </div>
                  </div>
                  {!slot.ready ? (
                    <p className="mt-1 pl-6 text-xs text-warning-primary">
                      {m.records_collect_plan_not_ready()}
                    </p>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>

      {error ? <p className="mt-3 text-sm text-error-primary">{error}</p> : null}

      <div className="mt-4 flex justify-center">
        <Button
          size="md"
          color="primary"
          className={`px-8 ${RECORDS_PRIMARY_BUTTON_CLASSNAME}`}
          isDisabled={busy || props.disabled}
          isLoading={busy}
          onPress={() => void onSubmit()}
        >
          {m.records_collect_plan_submit()}
        </Button>
      </div>
    </div>
  );
}

function CollectPathRow(props: {
  value: string;
  disabled?: boolean;
  canRemove: boolean;
  autoFocus: boolean;
  onChange: (value: string) => void;
  onAdd: () => void;
  onRemove: () => void;
  onFocused: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!props.autoFocus) return;
    inputRef.current?.focus();
    props.onFocused();
  }, [props.autoFocus, props.onFocused]);
  return (
    <div className="flex items-center gap-2 py-1">
      <input
        ref={inputRef}
        value={props.value}
        disabled={props.disabled}
        aria-label={m.records_collect_plan_paths()}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (props.disabled || event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            props.onAdd();
            return;
          }
          if (event.key === "Backspace" && props.value === "" && props.canRemove) {
            event.preventDefault();
            props.onRemove();
          }
        }}
        className="min-w-0 flex-1 bg-transparent font-mono text-sm text-tertiary outline-none disabled:opacity-60"
      />
      <ButtonUtility
        type="button"
        size="xs"
        color="tertiary"
        icon={Edit}
        aria-label={m.records_collect_plan_paths()}
        isDisabled={props.disabled}
        onClick={() => inputRef.current?.focus()}
      />
    </div>
  );
}
