import { renderMessageSender, type AgentMessageRecord } from "@lrm/coforge-sdk/internal";

/** The sender exactly as an Agent-visible message line shows it:
 * `system` for a system message, `@handle — description` when a description exists, `@handle`
 * alone otherwise. */
function messageSender(message: AgentMessageRecord): string {
  return renderMessageSender(message.senderKind, message.senderHandle, message.senderDescription);
}

/** Any target containing `:` is a thread target (a channel/DM plus a rooting message id). */
function isThreadTarget(target: string): boolean {
  return target.includes(":");
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Renders an ISO `createdAt` timestamp as UTC `YYYY-MM-DD HH:MM:SSZ`. */
export function formatUtcTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}Z`;
}

function attachmentSuffix(message: AgentMessageRecord): string {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) return "";
  const noun = attachments.length === 1 ? "attachment" : "attachments";
  const list = attachments.map(({ fileName, id }) => `${fileName} (id:${id})`).join(", ");
  return ` [${attachments.length} ${noun}: ${list} — use \`coforge attachment view --id <attachmentId> --output <path>\` to download]`;
}

function taskSuffix(message: AgentMessageRecord): string {
  if (!message.task) return "";
  const owner = message.task.owner
    ? ` owner=@${message.task.owner.handle}${message.task.owner.deleted ? " [deleted]" : ""}`
    : "";
  return ` [task #${message.task.number} status=${message.task.status}${owner}]`;
}

/** Channel check/resolve lines longer than this are cut; the agent can `read --around` for the rest. */
const CHANNEL_SUMMARY_CHARS = 200;

/** A parent channel (`#name`), not a thread (`#name:rootId`) and not a DM. */
function isPlainChannelTarget(target: string): boolean {
  return target.startsWith("#") && !isThreadTarget(target);
}

/** Truncate a plain-channel body so check does not dump the full post into the transcript. */
function channelSummaryBody(message: AgentMessageRecord): string {
  if (!isPlainChannelTarget(message.target) || message.mentionsAgent) return message.body;
  const points = Array.from(message.body);
  if (points.length <= CHANNEL_SUMMARY_CHARS) return message.body;
  const shown = points.slice(0, CHANNEL_SUMMARY_CHARS).join("");
  const hidden = points.length - CHANNEL_SUMMARY_CHARS;
  return `${shown}…(+${hidden} chars, read: coforge message read --target "${message.target}" --around ${shortId(message.id)})`;
}

/** The message line shared by `message check`, `message resolve`, and held Task context. */
export function formatMessageLine(message: AgentMessageRecord): string {
  return `[target=${message.target} msg=${shortId(message.id)} time=${formatUtcTimestamp(message.createdAt)} type=${message.senderKind}] ${messageSender(message)}: ${channelSummaryBody(message)}${attachmentSuffix(message)}${taskSuffix(message)}`;
}

type ReadWindowResponse = {
  messages?: AgentMessageRecord[];
  hasOlder?: boolean;
  hasNewer?: boolean;
};

export function formatReadWindow(
  target: string,
  response: ReadWindowResponse,
  options: { around?: string } = {},
): string {
  const messages = response.messages ?? [];
  if (messages.length === 0) return `No messages in ${target}.`;

  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  const older = response.hasOlder
    ? `Older exist: coforge message read --target "${target}" --before ${shortId(first.id)}.`
    : "No older.";
  const newer = response.hasNewer
    ? `Newer exist: coforge message read --target "${target}" --after ${shortId(last.id)}.`
    : "No newer.";

  const lines = [`Read window: ${messages.length} returned, oldest to newest. ${older} ${newer}`];
  if (options.around) lines.push(`Around: ${options.around}.`);
  lines.push("");

  const includeReplyTarget = !isThreadTarget(target);
  messages.forEach((message, index) => {
    const replyTarget = includeReplyTarget ? ` replyTarget=${target}:${shortId(message.id)}` : "";
    lines.push(
      `[${index + 1}/${messages.length} msg=${message.id} time=${formatUtcTimestamp(message.createdAt)} type=${message.senderKind}${replyTarget}] ${messageSender(message)}: ${message.body}${attachmentSuffix(message)}${taskSuffix(message)}`,
    );
  });

  lines.push("");
  lines.push(`End of window: ${messages.length}/${messages.length} shown.`);
  return lines.join("\n");
}

const STRUCTURAL_TAG_PATTERN = /<\/?(?:result|preview|match)>|<omit \/>/g;
const REFERENCE_BOUNDARY = String.raw`[\s\[\]\(\)\{\}"'` + "`]";
const MENTION_PATTERN = new RegExp(`(^|${REFERENCE_BOUNDARY})@([A-Za-z0-9][\\w-]*)`, "g");
const CHANNEL_PATTERN = new RegExp(`(^|${REFERENCE_BOUNDARY})#([A-Za-z][\\w-]*)`, "g");
const TASK_REFERENCE_PATTERN = /\btask #(\d+)/gi;

/**
 * Rewrites reference-looking literals in free text so quoted content cannot pass as a real
 * reference, and escapes literal occurrences of the structural tags used to frame search
 * results/previews.
 */
export function neutralizeReferenceLiterals(text: string): string {
  let result = text.replace(STRUCTURAL_TAG_PATTERN, (tag) =>
    tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  );
  result = result.replace(
    MENTION_PATTERN,
    (_match, boundary: string, name: string) => `${boundary}user:${name}`,
  );
  result = result.replace(
    CHANNEL_PATTERN,
    (_match, boundary: string, name: string) => `${boundary}channel:${name}`,
  );
  result = result.replace(TASK_REFERENCE_PATTERN, (_match, number: string) => `task:${number}`);
  return result;
}

function indexOfCaseInsensitive(haystack: string, needle: string): number {
  if (!needle) return -1;
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

/** The first whitespace-separated term of a search query; a quoted phrase counts as one term. */
function firstQueryTerm(query: string): string {
  const trimmed = query.trim();
  const match = /^"([^"]*)"|^(\S+)/.exec(trimmed);
  if (!match) return "";
  return (match[1] ?? match[2] ?? "").trim();
}

const PREVIEW_LEADING_CONTEXT = 80;
const PREVIEW_TRAILING_CONTEXT = 120;
const PREVIEW_NO_MATCH_LENGTH = 200;

/** Builds one search-result preview: a matched window of `body`, or the first 200 characters. */
export function renderSearchPreview(body: string, query: string): string {
  const trimmedQuery = query.trim();
  let matchStart = -1;
  let matchLength = 0;

  if (trimmedQuery) {
    const index = indexOfCaseInsensitive(body, trimmedQuery);
    if (index >= 0) {
      matchStart = index;
      matchLength = trimmedQuery.length;
    }
  }
  if (matchStart < 0) {
    const term = firstQueryTerm(query);
    if (term) {
      const index = indexOfCaseInsensitive(body, term);
      if (index >= 0) {
        matchStart = index;
        matchLength = term.length;
      }
    }
  }

  const hasMatch = matchStart >= 0;
  const matchEnd = matchStart + matchLength;
  const windowStart = hasMatch ? Math.max(0, matchStart - PREVIEW_LEADING_CONTEXT) : 0;
  const windowEnd = hasMatch
    ? Math.min(body.length, matchEnd + PREVIEW_TRAILING_CONTEXT)
    : Math.min(body.length, PREVIEW_NO_MATCH_LENGTH);
  const cutStart = hasMatch && windowStart > 0;
  const cutEnd = windowEnd < body.length;

  let pre = hasMatch ? body.slice(windowStart, matchStart) : "";
  const matched = hasMatch ? body.slice(matchStart, matchEnd) : "";
  let post = hasMatch ? body.slice(matchEnd, windowEnd) : body.slice(windowStart, windowEnd);

  if (cutStart) pre = pre.trimStart();
  if (cutEnd) post = post.trimEnd();

  const safePre = neutralizeReferenceLiterals(pre);
  const safeMatched = neutralizeReferenceLiterals(matched);
  const safePost = neutralizeReferenceLiterals(post);
  const core = hasMatch ? `${safePre}<match>${safeMatched}</match>${safePost}` : safePost;

  return `${cutStart ? "<omit />" : ""}${core}${cutEnd ? "<omit />" : ""}`;
}

type SearchResponse = {
  messages?: AgentMessageRecord[];
};

const SEARCH_CONTEXT_TIP =
  'If a result may be relevant but its preview is not enough, read its surrounding context with coforge message read --target "<target>" --around <shortId>.';

export function formatSearchResults(query: string, response: SearchResponse): string {
  const messages = response.messages ?? [];
  if (messages.length === 0) return "No search results.";

  const count = messages.length;
  const noun = count === 1 ? "result" : "results";
  const header = query
    ? `Search results for: "${query}" (${count} ${noun})`
    : `Filtered message results (${count} ${noun})`;

  const blocks = messages.map((message) =>
    [
      `<result ref="msg:${message.id}">`,
      `Source: ${message.target}`,
      `Sender: ${neutralizeReferenceLiterals(messageSender(message))}`,
      `Time: ${formatUtcTimestamp(message.createdAt)}`,
      "",
      "<preview>",
      renderSearchPreview(message.body, query),
      "</preview>",
      "</result>",
    ].join("\n"),
  );

  return `${header}\n\n${blocks.join("\n\n")}\n\n${SEARCH_CONTEXT_TIP}`;
}

type SendResponse = {
  messageId?: string;
};

/**
 * `recentUnread` is only ever non-empty when the send bypassed a freshness hold via `--anyway`;
 * every other successful send passes an empty array or `undefined`.
 */
export function formatSendSuccess(
  target: string,
  response: SendResponse,
  recentUnread?: readonly AgentMessageRecord[],
): string {
  const base = !response.messageId
    ? `Message sent to ${target}.`
    : (() => {
        const hint = isThreadTarget(target)
          ? ""
          : ` (to reply in this message's thread, use target "${target}:${shortId(response.messageId!)}")`;
        return `Message sent to ${target}. Message ID: ${response.messageId}${hint}`;
      })();
  if (!recentUnread?.length) return base;
  return [
    base,
    "",
    "--- New messages you may have missed ---",
    ...recentUnread.map(formatMessageLine),
  ].join("\n");
}

type AttachmentUploadResponse = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

/** Matches Raft 1.0.32's `formatAttachmentUploaded` shape exactly, `raft` swapped for `coforge`. */
export function formatAttachmentUploadSuccess(response: AttachmentUploadResponse): string {
  const sizeKB = (response.sizeBytes / 1024).toFixed(1);
  return (
    `File uploaded: ${response.fileName} (${sizeKB}KB)\n` +
    `Attachment ID: ${response.id}\n\n` +
    `Use this ID with coforge message send --attachment-id ${response.id} to include it in a message.`
  );
}

/** Matches Raft 1.0.32's `formatAttachmentDownloaded` shape exactly. */
export function formatAttachmentDownloadSuccess(output: string): string {
  return `Downloaded to: ${output}`;
}

type HeldSendResponse = {
  decision?: "local_hold" | "syncing_hold";
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  heldMessages?: AgentMessageRecord[];
  continueAnywaySuggested?: boolean;
};

/** Raft 1.0.32's `HOLD_PREVIEW_CHARS`: the held-context preview cut, counted in code points. */
const HELD_PREVIEW_CHARS = 160;

function formatUtcHourMinute(createdAt: string): string {
  return formatUtcTimestamp(createdAt).slice(11, 16);
}

/** Raft 1.0.32's `previewLine`: `  │ @sender HH:MM  content…⟨n more chars⟩`. */
function heldPreviewLine(message: AgentMessageRecord): string {
  const collapsed = message.body.replace(/\s+/g, " ").trim();
  const points = Array.from(collapsed);
  const shown = points.slice(0, HELD_PREVIEW_CHARS).join("");
  const hidden = points.length - Math.min(points.length, HELD_PREVIEW_CHARS);
  const head = [messageSender(message), formatUtcHourMinute(message.createdAt)]
    .filter(Boolean)
    .join(" ");
  const marker = hidden > 0 ? `…⟨${hidden} more chars⟩` : "";
  return `  │ ${head}  ${shown}${marker}`;
}

/**
 * Raft 1.0.32's held-send notice (`formatHeldSendOutput` → `formatFreshnessHoldOutput`): the
 * opening count line, the bounded held-context window with its omitted-earlier-messages note, the
 * "choose one path" recovery block, and the `--anyway` escape only when the server suggests it.
 */
export function formatHeldSend(target: string, response: HeldSendResponse): string {
  const heldMessages = response.heldMessages ?? [];
  const newMessageCount = response.newMessageCount ?? heldMessages.length;
  const shownMessageCount = response.shownMessageCount ?? heldMessages.length;
  const omittedMessageCount = response.omittedMessageCount ?? 0;
  const messageNoun = newMessageCount === 1 ? "message" : "messages";

  const lines: string[] = [];
  if (omittedMessageCount > 0 && heldMessages.length > 0) {
    const noun = omittedMessageCount === 1 ? "message" : "messages";
    lines.push(
      `  ├ ⋯ ${omittedMessageCount} earlier ${noun} skipped in this notice. Older exist: coforge message read --target "${target}" --before ${shortId(heldMessages[0]!.id)}. ⋯`,
    );
  }
  if (heldMessages.length > 0) {
    lines.push(`  ├ Latest ${shownMessageCount} ${"─".repeat(28)}`);
    for (const message of heldMessages) lines.push(heldPreviewLine(message));
  }
  lines.push(`  └ Previews are truncated. Full text: coforge message read --target "${target}"`);

  const paths = [
    "After reviewing the current state of this conversation, choose one path.",
    "To update the draft, send revised content normally:",
    `  coforge message send --target "${target}" <<'COFORGE_MESSAGE'`,
    "  revised message",
    "  COFORGE_MESSAGE",
    "To send the current draft unchanged:",
    `  coforge message send --send-draft --target "${target}"`,
    "  (this sends the stored copy — do not use it if you meant to change the content)",
    "You can also choose not to send anything.",
  ];
  if (response.continueAnywaySuggested)
    paths.push(
      "If repeated updates keep blocking the same draft and this is still the right reply, you may use:",
      `  coforge message send --send-draft --anyway --target "${target}"`,
    );

  return [
    `Held — ${newMessageCount} unread ${messageNoun} in ${target}. Your message has been saved as a draft.`,
    "",
    lines.join("\n"),
    "",
    paths.join("\n"),
  ].join("\n");
}
