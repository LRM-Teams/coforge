import type { ActivityEntry } from "./agent-activity";
import type { AgentDisplaySnapshot, ActivityTrajectoryEntry } from "@lrm/coforge-sdk/internal";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  TOOL_LABELS,
  canonicalToolName,
  toolActivityLabel,
  isToolActivityLabel,
} from "@lrm/coforge-sdk/internal";
import type { StatusTone } from "@/components/ui/status-dot";

export type ActivityObservation = Pick<
  ActivityEntry,
  "activityKind" | "detailKind" | "detail" | "level" | "entries"
>;
/** Agent activity tones; `online` is a Computer-only presence tone (see `StatusDot`). */
export type ActivityTone = Exclude<StatusTone, "online">;
type Tone = ActivityTone;
/** Activity labels are not internationalized (AGENTS.md); reused verbatim for the persisted
 * "user stopped this Agent" (ADR 0038) status text, not just the offline-history activity row. */
export const STOPPED_STATUS_DETAIL = "Stopped — won't receive messages until restarted";
export type ActivityRow = {
  label: string;
  detail: string;
  recentLabel: string;
  currentLabel: string | null;
  tone: Tone;
  recentTone: Tone;
  pulse: boolean;
  monospace: boolean;
  expandable: boolean;
  subagent?: { parentToolUseId: string };
};

/**
 * ADR 0021 (amended): tool_end, thinking_end and compaction_finished are entry-less status
 * frames that are now persisted and shown live like any other Activity. Their primary label
 * still comes from the ordinary activity-kind classification above (`activityKindForObservation`
 * on the server puts all three under "working", so the primary label reads "Working" the same as
 * any other busy frame). Current daemons send their own secondary text in `detail` ("Tool
 * finished", "Thinking finished"); this map is only the fallback wording for an empty `detail`
 * (older daemons, and rows stored before the daemon started sending text) — see the `detail ||
 * STATUS_SECONDARY_LABEL[kind]` use below. `runtime_progress` has no entry here — it stays a
 * content-free liveness filler, never persisted or shown in the timeline (see
 * POPOVER_EXCLUDED_DETAIL_KINDS in agent-activity.ts), so falling through to its empty raw
 * `detail` below (no secondary text at all) is correct for it too.
 */
const STATUS_SECONDARY_LABEL: Readonly<Record<string, string>> = {
  [AGENT_ACTIVITY_DETAIL_KIND.TOOL_END]: "Tool finished",
  [AGENT_ACTIVITY_DETAIL_KIND.THINKING_END]: "Thinking finished",
  [AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED]: "Compaction finished",
  [AGENT_ACTIVITY_DETAIL_KIND.REVIEW_FINISHED]: "Review finished",
};

/** One atom of a presented activity frame: 0 or 1 visible row, plus (for text/thinking
 * atoms only) a `mergeGroup` naming the contiguous statement it belongs to. A hidden
 * `send_message` tool call has no row and no `mergeGroup` — it still occupies a slot in
 * the atom sequence, so `presentActivityRows` sees it as a real boundary between two
 * separate statements even though nothing renders for it. */
type ActivityAtom = { row?: ActivityRow; mergeGroup?: string };

function presentEntryItem(
  item: ActivityTrajectoryEntry,
  kind: string,
  detail: string,
): ActivityAtom {
  if (item.kind === "tool_start") {
    const { canonical, name } = canonicalToolName(item.toolName);
    if (canonical === "send_message") return {};
    const label = TOOL_LABELS[canonical] ?? name;
    return {
      row: {
        label,
        // An already-redacted argument summary from the entry itself takes
        // precedence; older daemons and stored rows have no toolInput. A
        // current daemon's own `detail` is by then already this same generic
        // label (see `toolActivityLabel`), so echoing it here as a "detail"
        // would just repeat the label; only an older daemon's raw detail is
        // worth showing.
        detail: item.toolInput ?? (isToolActivityLabel(detail) ? "" : detail),
        recentLabel: label,
        currentLabel: toolActivityLabel(item.toolName),
        tone: "working",
        recentTone: "working",
        pulse: false,
        monospace: true,
        expandable: false,
        subagent: item.subagent,
      },
    };
  }
  if (item.kind === "system") {
    // A daemon-injected system/control message. Never merged with a
    // neighbouring text/thinking row: returning no `mergeGroup` closes
    // whatever statement merge group was open before it.
    return {
      row: {
        label: item.title,
        detail: item.text,
        recentLabel: item.title,
        currentLabel: item.title,
        tone: "output",
        recentTone: "working",
        pulse: false,
        monospace: true,
        expandable: true,
        subagent: item.subagent,
      },
    };
  }
  const thinking = item.kind === "thinking";
  return {
    row: {
      label: thinking ? "Thinking" : "Output",
      detail: item.text,
      recentLabel: item.text || (thinking ? "Thinking" : "Output"),
      currentLabel: thinking
        ? "Thinking…"
        : kind === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_RECONNECTING ||
            kind === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_UNAVAILABLE
          ? detail || "Working…"
          : "Working…",
      tone: thinking ? "thinking" : "output",
      recentTone: thinking ? "thinking" : "working",
      pulse: thinking,
      monospace: true,
      expandable: true,
      subagent: item.subagent,
    },
    mergeGroup: `${thinking ? "thinking" : "text"}:${item.subagent?.parentToolUseId ?? ""}`,
  };
}

function activityAtoms(observation: ActivityObservation): ActivityAtom[] {
  const { detailKind: kind, level, detail } = observation;
  // ADR 0021: any activity reclassified as subagent_activity (a trajectory
  // entry carrying a subagent scope) shows one unified label, regardless of
  // its underlying entries.
  if (kind === AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY && level !== "error") {
    return [
      {
        row: {
          label: "Subagent working",
          detail: "",
          recentLabel: "Subagent working…",
          currentLabel: "Subagent working…",
          tone: "working",
          recentTone: "working",
          pulse: true,
          monospace: false,
          expandable: false,
        },
      },
    ];
  }
  if (level !== "error") {
    const entries = observation.entries ?? [];
    if (entries.length) return entries.map((entry) => presentEntryItem(entry, kind, detail));
  }
  const tone: Tone =
    level === "error"
      ? "error"
      : observation.activityKind === "online"
        ? "idle"
        : (observation.activityKind ?? "unknown");
  const starting = tone === "working" && kind === AGENT_ACTIVITY_DETAIL_KIND.STARTING;
  const compacting = tone === "working" && kind === AGENT_ACTIVITY_DETAIL_KIND.COMPACTING_CONTEXT;
  const reviewing = tone === "working" && kind === AGENT_ACTIVITY_DETAIL_KIND.REVIEWING_CHANGES;
  const compactionStale =
    tone === "working" && kind === AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_STALE;
  const reviewStale = tone === "working" && kind === AGENT_ACTIVITY_DETAIL_KIND.REVIEW_STALE;
  const stalledRecovery =
    tone === "working" && kind === AGENT_ACTIVITY_DETAIL_KIND.STALLED_RECOVERY;
  const stalled = tone === "error" && kind === AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_STALLED;
  const label =
    tone === "error"
      ? stalled
        ? "Stalled"
        : "Error"
      : starting
        ? "Starting"
        : compacting
          ? "Compacting context"
          : reviewing
            ? "Reviewing changes"
            : compactionStale
              ? "Compaction still running"
              : reviewStale
                ? "Review still running"
                : stalledRecovery
                  ? "Restarting stalled provider"
                  : tone === "working"
                    ? "Working"
                    : tone === "thinking"
                      ? "Thinking"
                      : tone === "idle"
                        ? "Idle"
                        : tone === "offline"
                          ? "Stopped"
                          : "Activity";
  const recentLabel =
    tone === "working"
      ? starting
        ? "Starting…"
        : compacting
          ? "Compacting context…"
          : reviewing
            ? "Reviewing changes…"
            : compactionStale
              ? "Compaction still running…"
              : reviewStale
                ? "Review still running…"
                : stalledRecovery
                  ? "Restarting stalled provider…"
                  : // These two kinds carry an argument-free `detail` from a current daemon
                    // (see `toolActivityLabel`, kept as is), but an older, not-yet-upgraded
                    // daemon's entry-less heartbeat/probe reply still resends its own last raw
                    // `detail` (a command or path) here — never show that as the header label.
                    kind === AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND
                    ? isToolActivityLabel(detail)
                      ? detail
                      : "Running command…"
                    : kind === AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED
                      ? isToolActivityLabel(detail)
                        ? detail
                        : "Working…"
                      : detail || "Working…"
      : tone === "thinking"
        ? "Thinking…"
        : tone === "idle"
          ? "Online"
          : tone === "offline"
            ? STOPPED_STATUS_DETAIL
            : tone === "error"
              ? stalled
                ? detail
                  ? `Stalled: ${detail}`
                  : "Stalled"
                : detail
                  ? `Error: ${detail}`
                  : "Error"
              : detail || label;
  // Completion rows prefer the daemon's own detail ("Tool finished") and fall back to
  // STATUS_SECONDARY_LABEL for frames reported or stored with an empty one.
  const statusSecondary =
    kind in STATUS_SECONDARY_LABEL ? detail || STATUS_SECONDARY_LABEL[kind] : undefined;
  const secondary =
    statusSecondary ?? (starting || (tone === "offline" && detail === "Stopped") ? "" : detail);
  return [
    {
      row: {
        label,
        // A detail that only repeats the label ("Idle", "Compacting context") adds nothing.
        detail: secondary.toLowerCase() === label.toLowerCase() ? "" : secondary,
        recentLabel,
        currentLabel: tone === "working" || tone === "thinking" ? recentLabel : null,
        tone,
        recentTone: tone,
        pulse: tone === "working" || tone === "thinking",
        monospace: false,
        expandable: false,
      },
    },
  ];
}

/** Display-only projection: never derive Agent availability from these tones. */
export function presentActivity(observation: ActivityObservation): ActivityRow[] {
  return activityAtoms(observation).flatMap((atom) => (atom.row ? [atom.row] : []));
}

export type PresentedActivityRow = ActivityRow & { observedAtMs: number; key: string };

/**
 * `presentActivity` per activity frame, plus one merge: consecutive text (or thinking)
 * atoms of the same launch and subagent lineage, with nothing else between them in the
 * true entry sequence (not just the visible rows — a hidden `send_message` tool call
 * still separates them), render as one row. Its text is every fragment concatenated
 * oldest-to-newest with no separator (they are contiguous slices of one stream), its
 * timestamp and key come from the oldest fragment (stable identity while later
 * fragments stream in and extend it), and `currentLabel` reflects the newest fragment.
 * `activity` is newest-first (`orderActivity`); the merged output stays newest-first.
 */
export function presentActivityRows(activity: readonly ActivityEntry[]): PresentedActivityRow[] {
  const chronological = [...activity].reverse().flatMap((entry) =>
    activityAtoms(entry).map((atom, itemIndex) => ({
      row: atom.row,
      mergeGroup: atom.mergeGroup ? `${entry.launchId}:${atom.mergeGroup}` : undefined,
      observedAtMs: entry.observedAtMs,
      key: `${entry.launchId}:${entry.clientSeq}:${itemIndex}`,
    })),
  );
  const merged: PresentedActivityRow[] = [];
  let openGroup: string | undefined;
  for (const atom of chronological) {
    if (atom.mergeGroup && atom.mergeGroup === openGroup) {
      const last = merged[merged.length - 1];
      const detail = last.detail + (atom.row?.detail ?? "");
      merged[merged.length - 1] = {
        ...last,
        detail,
        recentLabel: detail || last.label,
        currentLabel: atom.row?.currentLabel ?? last.currentLabel,
      };
    } else if (atom.row) {
      merged.push({ ...atom.row, observedAtMs: atom.observedAtMs, key: atom.key });
    }
    openGroup = atom.mergeGroup;
  }
  return merged.reverse();
}

/**
 * Format a cloud decision. No clocks, process facts or history reduction here.
 *
 * `stopped` (ADR 0038, a user-persisted intent, not a display fact) never changes `isOnline` or
 * `label` — the Start/Stop button choice and the short status word stay exactly what the Daemon
 * reports. It only adds `statusDetail`, an un-internationalized caption (AGENTS.md) reusing the
 * existing Activity "Stopped — …" sentence, shown only when the display itself is already
 * offline: a stopped Agent whose Daemon has not yet caught up is still described by its real
 * display kind, not overridden into looking offline early.
 */
export function agentDisplay(display?: AgentDisplaySnapshot, options?: { stopped?: boolean }) {
  if (!display)
    return {
      kind: "unknown" as const,
      label: "Status unknown",
      isOnline: undefined,
      tone: "unknown" as const,
      pulse: false,
      // Never present; only shapes the inferred type to match the other branch's optional field.
      ...((false as boolean) ? { statusDetail: "" } : {}),
    };
  const kind = display.activityKind;
  const row = presentActivity({ ...display, level: kind === "error" ? "error" : "info" }).at(-1);
  const label =
    kind === "online"
      ? "Online"
      : kind === "offline"
        ? "Offline"
        : kind === "thinking"
          ? "Thinking…"
          : kind === "error"
            ? (row?.recentLabel ?? "Error")
            : (row?.currentLabel ?? "Working…");
  return {
    kind,
    label,
    isOnline: kind !== "offline",
    tone: kind === "online" ? ("idle" as const) : kind,
    pulse: kind === "working" || kind === "thinking",
    ...(options?.stopped === true && kind === "offline"
      ? { statusDetail: STOPPED_STATUS_DETAIL }
      : {}),
  };
}
