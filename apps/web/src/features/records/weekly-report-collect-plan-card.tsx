import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Edit01 as Edit, Settings01 as Settings } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select } from "@/components/base/select/select";
import { TextArea } from "@/components/base/textarea/textarea";
import { formatAgentProfileParam } from "@/features/agents/profile-panel/profile-panel-search";
import { m } from "@/paraglide/messages";
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
  const [pathsByComputer, setPathsByComputer] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listSlots().then((rows) => {
      if (cancelled) return;
      setSlots(rows);
      setSelected(rows.filter((row) => row.ready).map((row) => row.computerId));
      setPathsByComputer(
        Object.fromEntries(rows.map((row) => [row.computerId, "/home/jian40/\n"])),
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
        const scanPaths = (pathsByComputer[computerId] ?? "")
          .split("\n")
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

  return (
    <div className="space-y-3 rounded-xl border border-secondary bg-secondary p-3">
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-tertiary">{m.records_collect_plan_window()}</p>
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

      <div className="space-y-2">
        <p className="text-xs font-medium text-tertiary">{m.records_collect_plan_computers()}</p>
        {slots.length === 0 ? (
          <p className="text-sm text-tertiary">{m.records_collect_plan_no_owned()}</p>
        ) : (
          slots.map((slot) => {
            const checked = selected.includes(slot.computerId);
            return (
              <div
                key={slot.computerId}
                className="space-y-1 rounded-lg border border-secondary bg-primary p-2"
              >
                <div className="flex items-center gap-2">
                  <Checkbox
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
                <div className="flex items-start gap-2 pl-7">
                  <TextArea
                    size="sm"
                    className="min-w-0 flex-1"
                    textAreaClassName="min-h-12 font-mono text-xs"
                    value={pathsByComputer[slot.computerId] ?? ""}
                    onChange={(value) =>
                      setPathsByComputer((prev) => ({
                        ...prev,
                        [slot.computerId]: value,
                      }))
                    }
                    isDisabled={busy || props.disabled}
                    aria-label={m.records_collect_plan_paths()}
                  />
                  <Edit className="mt-1 size-4 shrink-0 text-tertiary" aria-hidden />
                </div>
                {!slot.ready ? (
                  <p className="pl-7 text-xs text-warning-primary">
                    {m.records_collect_plan_not_ready()}
                  </p>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {error ? <p className="text-sm text-error-primary">{error}</p> : null}

      <Button
        size="sm"
        color="primary"
        className="w-full"
        isDisabled={busy || props.disabled}
        isLoading={busy}
        onPress={() => void onSubmit()}
      >
        {m.records_collect_plan_submit()}
      </Button>
    </div>
  );
}
