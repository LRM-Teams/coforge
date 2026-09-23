import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, ChevronUp } from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { m } from "@/paraglide/messages";
import { loadWeeklyReportCollectRun } from "./records.functions";

function collectRunStatusLabel(status: string): string {
  switch (status) {
    case "collecting":
      return m.records_collect_run_status_collecting();
    case "synthesizing":
      return m.records_collect_run_status_synthesizing();
    case "cancelled":
      return m.records_collect_run_status_cancelled();
    case "done":
      return m.records_collect_run_status_done();
    case "awaiting_confirm":
      return m.records_collect_run_status_awaiting_confirm();
    default:
      return m.records_collect_run_status({ status });
  }
}

function slotTitle(status: string, name: string): string {
  if (status === "ready") return m.records_collect_pack_title({ name });
  if (status === "running") return m.records_collect_slot_running({ name });
  if (status === "empty") return m.records_collect_slot_empty({ name });
  if (status === "stalled") return m.records_collect_slot_stalled({ name });
  return m.records_collect_slot_failed({ name });
}

export function WeeklyReportCollectRunCard(props: {
  runId: string;
  /** Called while the run is synthesizing (and once when it leaves collecting). */
  onCollectAdvanced?: (status: string) => void;
}) {
  const load = useServerFn(loadWeeklyReportCollectRun);
  const [run, setRun] = useState<Awaited<ReturnType<typeof loadWeeklyReportCollectRun>> | null>(
    null,
  );
  const [openIds, setOpenIds] = useState<string[]>([]);
  const onAdvancedRef = useRef(props.onCollectAdvanced);
  onAdvancedRef.current = props.onCollectAdvanced;
  const leftCollectingNotified = useRef(false);

  useEffect(() => {
    leftCollectingNotified.current = false;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    async function refresh() {
      try {
        const next = await load({ data: { runId: props.runId } });
        if (cancelled) return;
        setRun(next);
        const notify = onAdvancedRef.current;
        if (next.status === "synthesizing") {
          notify?.(next.status);
        } else if (next.status !== "collecting" && !leftCollectingNotified.current) {
          leftCollectingNotified.current = true;
          notify?.(next.status);
        }
        // Stop once the wave is no longer in flight — including allTerminal with
        // status still briefly collecting before settle, or cancelled after LLM failure.
        const inFlight = next.status === "collecting" || next.status === "synthesizing";
        if ((!inFlight || next.allTerminal) && timer) {
          clearInterval(timer);
          timer = undefined;
        }
      } catch {
        // Keep last good snapshot; next poll retries.
      }
    }
    void refresh();
    timer = setInterval(() => void refresh(), 4000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [load, props.runId]);

  if (!run) {
    return <p className="text-sm text-tertiary">{m.records_collect_run_loading()}</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-tertiary">{collectRunStatusLabel(run.status)}</p>
      {run.slots.map((slot) => {
        const open = openIds.includes(slot.id);
        const failedLike =
          slot.status === "failed" || slot.status === "stalled" || slot.status === "cancelled";
        return (
          <div key={slot.id} className="rounded-lg border border-secondary bg-primary">
            <Button
              size="sm"
              color="tertiary"
              className="flex w-full items-center justify-between gap-2 px-3 py-2"
              onPress={() =>
                setOpenIds((prev) =>
                  prev.includes(slot.id) ? prev.filter((id) => id !== slot.id) : [...prev, slot.id],
                )
              }
            >
              <span className="min-w-0 truncate text-left text-sm font-medium text-primary">
                {slotTitle(slot.status, slot.computerLabel)}
              </span>
              {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </Button>
            {!open && failedLike && slot.failureReason ? (
              <p className="border-t border-secondary px-3 py-1.5 text-xs text-error-primary line-clamp-2">
                {slot.failureReason}
              </p>
            ) : null}
            {open ? (
              <div className="border-t border-secondary px-3 py-2">
                {slot.packMarkdown ? (
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs leading-5 text-secondary">
                    {slot.packMarkdown}
                  </pre>
                ) : (
                  <p className="text-sm text-tertiary">
                    {slot.failureReason ?? m.records_collect_slot_no_body()}
                  </p>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
