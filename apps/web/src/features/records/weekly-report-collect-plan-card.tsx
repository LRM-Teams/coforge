import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Edit01 as Edit, Settings01 as Settings } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Checkbox } from "#src/components/base/checkbox/checkbox";
import { Input } from "#src/components/base/input/input";
import { Select } from "#src/components/base/select/select";
import type { AgentProfileTab } from "#src/features/agents/profile-panel/profile-panel-search";
import { AgentProfilePanel } from "#src/features/agents/profile-panel/agent-profile-panel";
import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import type { OpenAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import { agentProfileQuery } from "#src/features/agents/profile-panel/agent-profile-queries";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { readCollectPlanDraft, writeCollectPlanDraft } from "./weekly-report-assistant-session";
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

function collectPlanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("COFORGE_APP_ERROR:NOT_FOUND"))
    return "当前周报不存在或已不是你的成员周报，请从周报页面重新发起采集。";
  if (message.includes("COFORGE_APP_ERROR:ACCESS_DENIED"))
    return "当前账号无权采集这份周报或所选 Computer。";
  if (message.includes("COFORGE_APP_ERROR:INVALID_INPUT"))
    return "采集 Agent 配置已失效，请重新打开卡片并配置 Collector。";
  return m.records_collect_plan_submit_failed();
}

export function WeeklyReportCollectPlanCard(props: {
  reportId: string;
  year: number;
  week: number;
  disabled?: boolean;
  onSubmitted?: (runId: string) => void;
  onOpenAgentProfile?: OpenAgentProfile;
  storageKey?: string;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const storageKey = `${workspaceSlug}:${props.storageKey ?? props.reportId}`;
  const listSlots = useServerFn(listWeeklyReportCollectorSlots);
  const ensure = useServerFn(ensureWeeklyReportCollector);
  const submit = useServerFn(submitWeeklyReportCollectPlan);
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
  const [initialized, setInitialized] = useState(false);
  const [profileAgentId, setProfileAgentId] = useState<string | null>(null);
  const [profileTab, setProfileTab] = useState<AgentProfileTab>("profile");
  const [configuringComputerId, setConfiguringComputerId] = useState<string | null>(null);
  const configuringAgent = useQuery(
    agentProfileQuery(
      slots.find((slot) => slot.computerId === configuringComputerId)?.collectorAgentId ??
        undefined,
    ),
  );

  useEffect(() => {
    if (!configuringComputerId || !configuringAgent.dataUpdatedAt) return;
    let cancelled = false;
    async function refresh() {
      try {
        const rows = await listSlots();
        if (cancelled) return;
        setSlots(rows);
      } catch {
        if (!cancelled) setError(m.records_collect_plan_ensure_failed());
      }
    }
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [configuringComputerId, configuringAgent.dataUpdatedAt, listSlots]);

  useEffect(() => {
    let cancelled = false;
    const draft = readCollectPlanDraft(storageKey);
    if (draft) {
      setWindowKind(draft.windowKind);
      setOptionId(draft.optionId);
      setCustomStart(draft.customStart);
      setCustomEnd(draft.customEnd);
      setConfiguringComputerId(draft.configuringComputerId);
    }
    void listSlots()
      .then((rows) => {
        if (cancelled) return;
        setSlots(rows);
        setSelected(
          draft
            ? draft.selected.filter((id) => rows.some((row) => row.computerId === id))
            : rows.filter((row) => row.ready).map((row) => row.computerId),
        );
        setPathsByComputer(
          Object.fromEntries(
            rows.map((row) => [
              row.computerId,
              draft?.pathsByComputer[row.computerId] ??
                collectPathLines(defaultCollectScanPath(row.platform)),
            ]),
          ),
        );
        setInitialized(true);
      })
      .catch(() => {
        if (!cancelled) setError(m.records_collect_plan_ensure_failed());
      });
    return () => {
      cancelled = true;
    };
  }, [listSlots, storageKey]);

  useEffect(() => {
    if (!initialized) return;
    writeCollectPlanDraft(storageKey, {
      windowKind,
      optionId,
      customStart,
      customEnd,
      selected,
      pathsByComputer,
      configuringComputerId,
    });
  }, [
    initialized,
    storageKey,
    windowKind,
    optionId,
    customStart,
    customEnd,
    selected,
    pathsByComputer,
    configuringComputerId,
  ]);

  const options = useMemo(() => listCollectWindowOptions(windowKind), [windowKind]);
  const selectedOption = options.find((row) => row.id === optionId) ?? options[0];

  function openProfile(agentId: string) {
    if (props.onOpenAgentProfile) props.onOpenAgentProfile(agentId, "profile");
    else {
      setProfileTab("profile");
      setProfileAgentId(agentId);
    }
  }

  async function onEnsure(computerId: string) {
    setBusy(true);
    setError(null);
    try {
      const binding = await ensure({ data: { computerId } });
      const rows = await listSlots();
      setSlots(rows);
      // New collectors start unconfigured; open Agent edit so the User can pick runtime.
      if (binding.collectorAgentId) {
        setConfiguringComputerId(computerId);
        setSelected((previous) => [...new Set([...previous, computerId])]);
        openProfile(binding.collectorAgentId);
      }
    } catch {
      setError(m.records_collect_plan_ensure_failed());
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit() {
    if (busy || props.disabled) return;
    if (selected.some((id) => !slots.find((slot) => slot.computerId === id)?.ready)) {
      setError(m.records_collect_plan_not_ready());
      return;
    }
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
    } catch (error) {
      setError(collectPlanErrorMessage(error));
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

  if (!initialized)
    return <p className="text-sm text-tertiary">{error ?? m.records_collect_run_loading()}</p>;

  return (
    <div className="@container rounded-xl border border-secondary bg-primary p-4">
      {profileAgentId ? (
        <ModalOverlay
          isOpen
          onOpenChange={(open) => {
            if (!open) setProfileAgentId(null);
          }}
        >
          <Modal className="w-[calc(100vw-2rem)] max-w-2xl">
            <Dialog
              aria-label={m.records_collect_plan_setup()}
              className="h-[40rem] overflow-hidden"
            >
              <AgentProfilePanel
                agentId={profileAgentId}
                requestedTab={profileTab}
                onTabChange={setProfileTab}
                onClose={() => setProfileAgentId(null)}
              />
            </Dialog>
          </Modal>
        </ModalOverlay>
      ) : null}
      <div className="grid grid-cols-1 items-start gap-x-3 gap-y-4 @sm:grid-cols-[4.5rem_minmax(0,1fr)]">
        <p className="pt-2 text-sm text-tertiary">{m.records_collect_plan_window()}</p>
        <div className="space-y-2">
          <Select
            aria-label={m.records_collect_plan_window()}
            size="sm"
            selectedKey={windowKind}
            onSelectionChange={(key) => {
              if (typeof key === "string") {
                const kind = key as CollectWindowKind;
                setWindowKind(kind);
                setOptionId(
                  kind === "week"
                    ? `${props.year}-W${props.week}`
                    : (listCollectWindowOptions(kind)[0]?.id ?? ""),
                );
              }
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
                        isDisabled={busy || props.disabled}
                        onPress={() => void onEnsure(slot.computerId)}
                      >
                        {m.records_collect_plan_setup()}
                      </Button>
                    ) : null}
                    {slot.collectorAgentId ? (
                      <ButtonUtility
                        size="sm"
                        color="tertiary"
                        icon={Settings}
                        aria-label={m.records_collect_plan_gear()}
                        isDisabled={busy || props.disabled}
                        onClick={() => {
                          setConfiguringComputerId(slot.computerId);
                          openProfile(slot.collectorAgentId!);
                        }}
                      />
                    ) : null}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <Checkbox
                      className={`${COLLECT_PLAN_CHECKBOX_CLASSNAME} self-center`}
                      isSelected={checked}
                      isDisabled={busy || props.disabled}
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
          isDisabled={
            busy ||
            props.disabled ||
            selected.some((id) => !slots.find((slot) => slot.computerId === id)?.ready)
          }
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
