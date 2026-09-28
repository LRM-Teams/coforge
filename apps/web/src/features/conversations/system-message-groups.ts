/**
 * Folding runs of system messages in the message stream. Task and membership notices arrive in
 * bursts (one per claim, move or assignment), and a burst of them pushes the conversation itself
 * off screen. Every run of two or more consecutive system messages is therefore shown as one
 * summary line ("There are 3 task updates") that expands to the notices it stands for; a lone
 * system message stays as it is.
 */

export type SystemMessageKind = "taskUpdate" | "reminder" | "system";

/** The order a summary lists its parts in. */
const SUMMARY_ORDER: readonly SystemMessageKind[] = ["taskUpdate", "reminder", "system"];

/** A leading word with no letter, digit, `@` or `#` in it: the emoji a notice may open with. */
const LEADING_SYMBOL_WORD = /^[^\p{L}\p{N}@#]+$/u;

/** Raft's task-update wording, plus CoForge's current `@x started|was assigned task #N.` notice.
 * As in Raft, an assignment (`📌 Assigned @x to task #N`) or an unassignment (`X unassigned #N`)
 * is not in this list, so it is summarized as a system message. */
const TASK_UPDATE =
  /\b(?:new tasks? created|converted a message to task #\d+|claimed #\d+|released #\d+|moved #\d+|deleted #\d+|(?:started|was assigned) tasks? #\d+)\b/iu;

const REMINDER =
  /^(?:Reminder\s+#\w+|Reminder(?: \([^)]+\))?:|.+?\s+(?:scheduled|canceled|cancelled)\s+(?:a\s+)?reminder\b)/iu;

function withoutLeadingSymbol(body: string): string {
  const text = body.trim();
  const space = text.indexOf(" ");
  if (space <= 0) return text;
  return LEADING_SYMBOL_WORD.test(text.slice(0, space)) ? text.slice(space + 1).trimStart() : text;
}

/** What a system message's text is about, which decides how its group is summarized. */
export function systemMessageKind(body: string): SystemMessageKind {
  const text = withoutLeadingSymbol(body);
  if (TASK_UPDATE.test(text)) return "taskUpdate";
  if (REMINDER.test(text)) return "reminder";
  return "system";
}

type StreamMessage = { id: string; senderKind: string };

export type StreamItem<M extends StreamMessage> =
  | { type: "message"; message: M }
  | { type: "systemGroup"; id: string; messages: M[] };

/**
 * The stream as rendered: every message in order, except that each run of two or more
 * consecutive system messages becomes one group. `breaksRun` lets the caller keep a run from
 * crossing a line the reader must still see between two messages (a day divider, the unread
 * divider); it is asked only about a system message that follows another system message.
 */
export function groupSystemMessages<M extends StreamMessage>(
  messages: readonly M[],
  breaksRun: (message: M, previous: M) => boolean = () => false,
): StreamItem<M>[] {
  const items: StreamItem<M>[] = [];
  let run: M[] = [];
  const flush = () => {
    if (run.length === 1) items.push({ type: "message", message: run[0]! });
    else if (run.length > 1)
      items.push({
        type: "systemGroup",
        id: `system-group:${run[0]!.id}:${run.at(-1)!.id}`,
        messages: run,
      });
    run = [];
  };
  for (const message of messages) {
    if (message.senderKind !== "system") {
      flush();
      items.push({ type: "message", message });
      continue;
    }
    const previous = run.at(-1);
    if (previous && breaksRun(message, previous)) flush();
    run.push(message);
  }
  flush();
  return items;
}

export type SystemGroupSummary = {
  total: number;
  /** Non-empty kinds only, task updates first and plain system messages last. */
  parts: { kind: SystemMessageKind; count: number }[];
};

export function summarizeSystemGroup(messages: readonly { body: string }[]): SystemGroupSummary {
  const counts = new Map<SystemMessageKind, number>();
  for (const message of messages) {
    const kind = systemMessageKind(message.body);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return {
    total: messages.length,
    parts: SUMMARY_ORDER.flatMap((kind) => {
      const count = counts.get(kind);
      return count ? [{ kind, count }] : [];
    }),
  };
}
