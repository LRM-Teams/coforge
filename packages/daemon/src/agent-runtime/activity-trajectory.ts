import type { AgentRuntimeEvent } from "@coforge/agent";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  type ActivitySubagent,
  type AgentActivityDetailKind,
} from "@lrm/coforge-sdk/internal";
import { createAgentActivity } from "./agent-activity";

/** Detail kinds that, like an error, mean the model moved on from thinking. */
const THINKING_TRIGGER_DETAIL_KINDS = new Set<AgentActivityDetailKind>([
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTING_CONTEXT,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED,
]);

/**
 * True when `event` means the model moved on from an open thinking run: a rendered
 * response resuming, a tool call starting or ending, context compaction, the turn
 * ending, or an error. `runtime_progress`, `session` and `usage` events never end
 * thinking, and neither does a further `thinking-delta` (it continues the same run).
 */
function endsThinking(event: AgentRuntimeEvent): boolean {
  switch (event.type) {
    case "text-delta":
    case "tool-start":
    case "tool-end":
    case "completed":
      return true;
    case "activity":
      return (
        event.activity.level === "error" ||
        THINKING_TRIGGER_DETAIL_KINDS.has(event.activity.detailKind)
      );
    default:
      return false;
  }
}

/** One instance per launch. Never retains tool arguments/output or hidden reasoning. */
export class ActivityTrajectory {
  #pending?: {
    kind: "text" | "thinking";
    text: string;
    subagent?: ActivitySubagent;
    truncated: boolean;
  };
  #timer?: ReturnType<typeof setTimeout>;
  #disposed = false;
  /**
   * The detail kind of the last activity actually forwarded downstream, excluding
   * `runtime_progress` (a content-free liveness filler that must not affect either
   * open-thinking or re-announcement bookkeeping). Drives both when a thinking run
   * closes (`accept()`) and when a fresh run re-announces its kind (`#startRun()`).
   */
  #lastAnnounced?: AgentActivityDetailKind;
  constructor(private readonly emit: (event: AgentRuntimeEvent) => void) {}

  accept(event: AgentRuntimeEvent) {
    if (this.#disposed) return;
    if (
      this.#lastAnnounced === AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED &&
      endsThinking(event)
    ) {
      this.flush();
      this.#forward({
        type: "activity",
        activity: createAgentActivity(
          AGENT_ACTIVITY_DETAIL_KIND.THINKING_END,
          "info",
          "Thinking finished",
        ),
      });
    }
    if (event.type === "text-delta" || event.type === "thinking-delta") {
      const kind = event.type === "text-delta" ? "text" : "thinking";
      if (
        this.#pending &&
        (this.#pending.kind !== kind ||
          this.#pending.subagent?.parentToolUseId !== event.subagent?.parentToolUseId)
      )
        this.flush();
      if (!this.#pending) this.#startRun(kind);
      const pending = this.#pending ?? {
        kind,
        text: "",
        subagent: event.subagent,
        truncated: false,
      };
      // Retain a bounded prefix; do not repeatedly emit tails of truncated secrets.
      const text = pending.text + event.text;
      pending.truncated ||= text.length > 8000;
      pending.text = text.slice(0, 8000);
      this.#pending = pending;
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.flush(), 350);
      return;
    }
    if (event.type === "tool-start" || event.type === "activity" || event.type === "completed")
      this.flush();
    this.#forward(event);
  }

  /**
   * Announces a fresh run's kind immediately, with no entries, so the Agent's status
   * flips to thinking/working at once instead of waiting for the 350ms flush (which
   * carries the entries, as before). Skipped when the kind is already the last
   * announced one — an idle-timer split continuing the same run re-announces nothing.
   */
  #startRun(kind: "text" | "thinking") {
    const detailKind =
      kind === "thinking"
        ? AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED
        : AGENT_ACTIVITY_DETAIL_KIND.MODEL_RESPONSE_STARTED;
    if (detailKind === this.#lastAnnounced) return;
    this.#forward({ type: "activity", activity: createAgentActivity(detailKind, "info", "") });
  }

  #forward(event: AgentRuntimeEvent) {
    if (
      event.type === "activity" &&
      event.activity.detailKind !== AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_PROGRESS
    )
      this.#lastAnnounced = event.activity.detailKind;
    // The daemon core turns a tool-start into its Activity downstream; count it as announced
    // here so the run that follows the tool call announces itself again.
    if (event.type === "tool-start") this.#lastAnnounced = AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED;
    this.emit(event);
  }

  flush() {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const pending = this.#pending;
    this.#pending = undefined;
    if (!pending) return;
    const chars = [...redactTrajectoryText(pending.text)];
    const text =
      chars.length > 2000 || pending.truncated
        ? chars.slice(0, 1999).join("") + "…"
        : chars.join("");
    if (!text) return;
    this.#forward({
      type: "activity",
      activity: {
        detailKind:
          pending.kind === "thinking"
            ? AGENT_ACTIVITY_DETAIL_KIND.THINKING_STARTED
            : AGENT_ACTIVITY_DETAIL_KIND.MODEL_RESPONSE_STARTED,
        level: "info",
        detail: "",
        observedAtMs: Date.now(),
        entries: [
          { kind: pending.kind, text, ...(pending.subagent ? { subagent: pending.subagent } : {}) },
        ],
      },
    });
  }

  dispose() {
    if (this.#disposed) return;
    this.flush();
    this.#disposed = true;
  }
}

// Best-effort redaction of the assembled buffer, including split deltas. This
// cannot guarantee that arbitrary model-emitted sensitive text is recognizable.
export function redactTrajectoryText(text: string) {
  return text
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}
