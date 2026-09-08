import type { AgentRuntimeEvent } from "@coforge/agent";
import type { ActivitySubagent } from "@coforge/protocol";

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
  constructor(private readonly emit: (event: AgentRuntimeEvent) => void) {}

  accept(event: AgentRuntimeEvent) {
    if (this.#disposed) return;
    if (event.type === "text-delta" || event.type === "thinking-delta") {
      const kind = event.type === "text-delta" ? "text" : "thinking";
      if (
        this.#pending &&
        (this.#pending.kind !== kind ||
          this.#pending.subagent?.parentToolUseId !== event.subagent?.parentToolUseId)
      )
        this.flush();
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
    this.emit({
      type: "activity",
      activity: {
        detailKind: pending.kind === "thinking" ? "thinking_started" : "model_response_started",
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
function redactTrajectoryText(text: string) {
  return text
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}
