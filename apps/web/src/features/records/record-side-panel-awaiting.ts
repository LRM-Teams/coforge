/** Markers used to resume the side-panel "assistant running" indicator after refresh. */

export type AwaitingResumeComment = {
  authorType: string;
  body: string;
  createdAt: string;
};

export type AwaitingResumeMessage = {
  author: "user" | "assistant";
  createdAt: string;
  suggestion?: unknown;
};

const AWAITING_WINDOW_MS = 180_000;

/**
 * Returns the awaiting-start timestamp when the side panel should show
 * "助理正在处理…" after a reload; otherwise null.
 *
 * Resumes when:
 * - latest assistant progress comment still says 请稍候 and no later DM reply, or
 * - latest visible DM turn is still from the user (agent reply pending).
 */
export function resolveAwaitingAssistantResume(
  comments: readonly AwaitingResumeComment[],
  messages: readonly AwaitingResumeMessage[],
  nowMs: number = Date.now(),
): number | null {
  const pendingComment = [...comments]
    .reverse()
    .find((row) => row.authorType === "assistant" && /请稍候/.test(row.body));
  if (pendingComment) {
    const pendingAt = Date.parse(pendingComment.createdAt);
    if (Number.isFinite(pendingAt) && nowMs - pendingAt <= AWAITING_WINDOW_MS) {
      const hasNewerAssistant = messages.some(
        (message) => message.author === "assistant" && Date.parse(message.createdAt) > pendingAt,
      );
      if (!hasNewerAssistant) return pendingAt;
    }
  }

  const last = messages.at(-1);
  if (last?.author === "user") {
    const pendingAt = Date.parse(last.createdAt);
    if (Number.isFinite(pendingAt) && nowMs - pendingAt <= AWAITING_WINDOW_MS) {
      return pendingAt;
    }
  }

  return null;
}
